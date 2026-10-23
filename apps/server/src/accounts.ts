/**
 * 账号（GitHub issue #36）：登录名 + 密码，另有可以随时改的显示名字。游客照常能玩，账号只是保住身份：
 * 换设备、清浏览器后还是同一个人，座位和房主身份跟着账号走，显示名字别人不能冒用。
 * 账号存在快照目录的 accounts.json，密码用 scrypt 加盐哈希。管理员由环境变量 ADMIN_USERNAMES 指定。
 * 注册用户可以上传头像，存在快照目录的 avatars/ 里，启动时读进内存（每个最多 64 KB）。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountInfo, AdminAccountRow } from '@shengji/protocol';
import { checkAvatar, type AvatarType } from './avatarImage.ts';

export interface Account {
  readonly id: string;
  /** 登录名，存小写 */
  readonly username: string;
  displayName: string;
  passwordHash: string;
  disabled: boolean;
  readonly createdAt: number;
  lastLoginAt: number | null;
  /** 这个账号的会话 token：在哪台设备登录都用它，座位跟着它走 */
  token: string | null;
  /** 头像文件名「内容哈希.扩展名」，换了头像哈希就变，网址跟着变，浏览器缓存不会看到旧的；没有头像为 null */
  avatar?: string | null;
}

interface AccountsFile {
  readonly version: 1;
  readonly accounts: readonly Account[];
}

export type AccountResult = { readonly ok: true; readonly account: Account } | { readonly ok: false; readonly message: string };

const USERNAME = /^[a-zA-Z0-9_]{3,20}$/;
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
/** 连续输错这么多次就锁一会儿 */
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

/** 显示名字比较时不分大小写、去掉首尾空白 */
const nameKey = (name: string) => name.trim().toLowerCase();

export function checkDisplayName(name: string): string | null {
  const n = name.trim();
  if (n.length < 1 || n.length > 12) return '显示名字要 1 到 12 个字';
  return null;
}

export function checkPassword(password: string): string | null {
  if (password.length < 6 || password.length > 64) return '密码要 6 到 64 位';
  return null;
}

/** 管理员重置密码时给的临时密码：去掉容易看错的字符 */
function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(10);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export class Accounts {
  private readonly byId = new Map<string, Account>();
  private readonly file: string | null;
  private readonly admins: ReadonlySet<string>;
  /** 每个登录名连续输错的次数和锁到什么时候 */
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();
  private readonly avatarDir: string | null;
  /** 账号 id → 头像图片 */
  private readonly avatars = new Map<string, { readonly data: Buffer; readonly type: AvatarType }>();

  constructor(dir: string | null, adminUsernames: readonly string[] = []) {
    this.admins = new Set(adminUsernames.map((u) => u.trim().toLowerCase()).filter(Boolean));
    this.file = dir ? join(dir, 'accounts.json') : null;
    this.avatarDir = dir ? join(dir, 'avatars') : null;
    if (this.avatarDir) mkdirSync(this.avatarDir, { recursive: true });
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as AccountsFile;
      for (const a of parsed.accounts) this.byId.set(a.id, { ...a });
    } catch (err) {
      console.error('读取账号文件失败：', (err as Error).message);
    }
    for (const a of this.byId.values()) {
      if (!a.avatar) continue;
      const img = this.avatarDir ? this.readAvatar(join(this.avatarDir, `${a.id}.${a.avatar.split('.')[1]}`)) : null;
      if (img) this.avatars.set(a.id, img);
      else a.avatar = null;
    }
  }

  private readAvatar(path: string): { data: Buffer; type: AvatarType } | null {
    try {
      const data = readFileSync(path);
      const img = checkAvatar(data);
      return typeof img === 'string' ? null : { data, type: img.type };
    } catch {
      return null;
    }
  }

  /** 账号很少、改动也少，每次改动都马上写盘（先写临时文件再改名，不会写坏） */
  private save(): void {
    if (!this.file) return;
    const data: AccountsFile = { version: 1, accounts: [...this.byId.values()] };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.file);
  }

  get(id: string): Account | undefined {
    return this.byId.get(id);
  }

  find(username: string): Account | undefined {
    const u = username.trim().toLowerCase();
    for (const a of this.byId.values()) if (a.username === u) return a;
    return undefined;
  }

  /** 这个名字是不是哪个账号的显示名字（except 是正在改名的那个账号自己） */
  nameTaken(name: string, except?: Account): boolean {
    const k = nameKey(name);
    for (const a of this.byId.values()) if (a !== except && nameKey(a.displayName) === k) return true;
    return false;
  }

  isAdmin(a: Account): boolean {
    return this.admins.has(a.username);
  }

  info(a: Account): AccountInfo {
    return { username: a.username, displayName: a.displayName, isAdmin: this.isAdmin(a), avatar: this.avatarUrl(a.id) };
  }

  // ---------- 头像 ----------

  /** 头像的网址，带上内容哈希；没有头像返回 null */
  avatarUrl(id: string): string | null {
    const a = this.byId.get(id);
    return a?.avatar ? `/avatar/${a.id}?v=${a.avatar.split('.')[0]}` : null;
  }

  /** 给 HTTP 接口用：头像图片和现在的哈希 */
  avatarFile(id: string): { readonly data: Buffer; readonly type: AvatarType; readonly version: string } | null {
    const a = this.byId.get(id);
    const img = this.avatars.get(id);
    return a?.avatar && img ? { ...img, version: a.avatar.split('.')[0] as string } : null;
  }

  /** 换头像；data 为 null 是删掉头像。不合格返回提示 */
  setAvatar(account: Account, data: Buffer | null): string | null {
    const old = account.avatar ?? null;
    if (data === null) {
      if (!old) return null;
      account.avatar = null;
      this.avatars.delete(account.id);
    } else {
      const img = checkAvatar(data);
      if (typeof img === 'string') return img;
      account.avatar = `${createHash('sha256').update(data).digest('hex').slice(0, 12)}.${img.ext}`;
      this.avatars.set(account.id, { data, type: img.type });
      if (this.avatarDir) {
        const path = join(this.avatarDir, `${account.id}.${img.ext}`);
        writeFileSync(`${path}.tmp`, data);
        renameSync(`${path}.tmp`, path);
      }
    }
    // 换了格式（或删了）：旧文件不要了
    const oldExt = old?.split('.')[1];
    if (this.avatarDir && oldExt && oldExt !== account.avatar?.split('.')[1]) {
      rmSync(join(this.avatarDir, `${account.id}.${oldExt}`), { force: true });
    }
    this.save();
    return null;
  }

  register(username: string, password: string, displayName: string): AccountResult {
    if (!USERNAME.test(username)) return { ok: false, message: '登录名要 3 到 20 位，只能用字母、数字和下划线' };
    if (this.find(username)) return { ok: false, message: '这个登录名已经有人用了' };
    const pw = checkPassword(password);
    if (pw) return { ok: false, message: pw };
    const dn = checkDisplayName(displayName);
    if (dn) return { ok: false, message: dn };
    if (this.nameTaken(displayName)) return { ok: false, message: '这个显示名字已经有人用了' };
    const account: Account = {
      id: randomBytes(9).toString('base64url'),
      username: username.toLowerCase(),
      displayName: displayName.trim(),
      passwordHash: hashPassword(password),
      disabled: false,
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
      token: null,
    };
    this.byId.set(account.id, account);
    this.save();
    return { ok: true, account };
  }

  /** 登录：连续输错 5 次锁 1 分钟；登录名不存在和密码不对给一样的提示 */
  login(username: string, password: string, now = Date.now()): AccountResult {
    const key = username.trim().toLowerCase();
    const f = this.failures.get(key);
    if (f && f.lockedUntil > now) return { ok: false, message: `输错太多次了，${Math.ceil((f.lockedUntil - now) / 1000)} 秒后再试` };
    const account = this.find(key);
    if (!account || !verifyPassword(password, account.passwordHash)) {
      const count = (f?.count ?? 0) + 1;
      this.failures.set(key, { count: count >= MAX_FAILURES ? 0 : count, lockedUntil: count >= MAX_FAILURES ? now + LOCK_MS : 0 });
      return { ok: false, message: '登录名或密码不对' };
    }
    if (account.disabled) return { ok: false, message: '这个账号已被管理员停用' };
    this.failures.delete(key);
    account.lastLoginAt = now;
    this.save();
    return { ok: true, account };
  }

  setDisplayName(account: Account, name: string): string | null {
    const err = checkDisplayName(name);
    if (err) return err;
    if (this.nameTaken(name, account)) return '这个显示名字已经有人用了';
    account.displayName = name.trim();
    this.save();
    return null;
  }

  changePassword(account: Account, oldPassword: string, newPassword: string): string | null {
    if (!verifyPassword(oldPassword, account.passwordHash)) return '原密码不对';
    const err = checkPassword(newPassword);
    if (err) return err;
    account.passwordHash = hashPassword(newPassword);
    this.save();
    return null;
  }

  setToken(account: Account, token: string): void {
    if (account.token === token) return;
    account.token = token;
    this.save();
  }

  // ---------- 管理员 ----------

  list(): AdminAccountRow[] {
    return [...this.byId.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => ({ username: a.username, displayName: a.displayName, isAdmin: this.isAdmin(a), disabled: a.disabled, createdAt: a.createdAt, lastLoginAt: a.lastLoginAt, avatar: this.avatarUrl(a.id) }));
  }

  /** 重置成一个临时密码并返回它；账号不存在返回 null */
  resetPassword(username: string): string | null {
    const account = this.find(username);
    if (!account) return null;
    const pw = tempPassword();
    account.passwordHash = hashPassword(pw);
    this.failures.delete(account.username);
    this.save();
    return pw;
  }

  setDisabled(username: string, disabled: boolean): Account | null {
    const account = this.find(username);
    if (!account) return null;
    account.disabled = disabled;
    this.save();
    return account;
  }
}
