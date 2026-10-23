/** 账号的整体流程（GitHub issue #36）：游客注册保留座位、名字保护、换设备登录接回座位、改名、退出登录、管理员、重启。 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@shengji/protocol';
import { startServer, type RunningServer } from '../src/server.ts';

const dir = mkdtempSync(join(tmpdir(), 'auth-'));
const roomOptions = { dealIntervalMs: 2, declareGraceMs: 30, botDelayMs: 2, searchBudgetMs: 5 };
let server: RunningServer;
beforeAll(async () => { server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false, snapshotDir: dir, adminUsernames: ['boss'], roomOptions }); });
afterAll(async () => { await server.close(); });

class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  private seen = 0;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString()) as ServerMessage));
  }
  open(): Promise<void> { return new Promise((r) => this.ws.once('open', () => r())); }
  send(m: ClientMessage): void { this.ws.send(JSON.stringify(m)); }
  /** 等下一条满足条件的新消息 */
  async next<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + 5000;
    for (;;) {
      for (; this.seen < this.inbox.length; this.seen++) {
        const m = this.inbox[this.seen] as ServerMessage;
        if (m.t === t && pred(m as Extract<ServerMessage, { t: T }>)) { this.seen++; return m as Extract<ServerMessage, { t: T }>; }
      }
      if (Date.now() > deadline) throw new Error(`等 ${t} 超时；收到 ${this.inbox.map((m) => m.t === 'error' ? `error:${m.code}` : m.t).join(' ')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

async function guest(name: string): Promise<Client> {
  const c = new Client(server.port);
  await c.open();
  c.send({ t: 'hello', name });
  await c.next('welcome');
  return c;
}

let zhaoToken = '';
let code = '';
/** 第一台设备：开局前断线会让座，所以等第二台设备登录后再关 */
let first: Client;

it('游客注册：沿用原来的会话，座位不动，房间里显示名字换成账号的、不再标游客', async () => {
  const c = await guest('路人甲');
  const token = (c.inbox.find((m) => m.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }>).token;
  c.send({ t: 'createRoom', players: 4 });
  const room = await c.next('room', (m) => Boolean(m.room?.seats[0]));
  code = room.room!.code;
  expect(room.room!.seats[0]).toMatchObject({ name: '路人甲', guest: true });
  c.send({ t: 'register', username: 'zhao', password: 'secret123', displayName: '小赵' });
  const w = await c.next('welcome', (m) => m.account !== null);
  expect(w).toMatchObject({ token, name: '小赵', account: { username: 'zhao', displayName: '小赵', isAdmin: false } });
  zhaoToken = w.token;
  const after = await c.next('room', (m) => m.room?.seats[0]?.name === '小赵');
  expect(after.room!.seats[0]!.guest).toBe(false);
  expect(after.room!.you).toBe(0);
  first = c;
}, 20_000);

it('游客不能用已注册的显示名字', async () => {
  const c = new Client(server.port);
  await c.open();
  c.send({ t: 'hello', name: '小赵' });
  const e = await c.next('error');
  expect(e.code).toBe('NAME_TAKEN');
  c.ws.close();
}, 20_000);

it('换一台设备登录：拿到账号的会话，接回座位和房主身份', async () => {
  const c = await guest('临时');
  c.send({ t: 'login', username: 'ZHAO', password: 'wrong!' });
  expect((await c.next('error')).code).toBe('LOGIN_FAILED');
  c.send({ t: 'login', username: 'ZHAO', password: 'secret123' });
  const w = await c.next('welcome', (m) => m.account !== null);
  expect(w.token).toBe(zhaoToken);
  const room = await c.next('room', (m) => m.room !== null);
  expect(room.room).toMatchObject({ code, you: 0, youAreHost: true });
  // 改显示名字：房间里跟着变；不能改成别人的
  c.send({ t: 'setDisplayName', displayName: '赵老师' });
  await c.next('room', (m) => m.room?.seats[0]?.name === '赵老师');
  expect((await c.next('account')).account.displayName).toBe('赵老师');
  const other = await guest('路人乙');
  other.send({ t: 'register', username: 'qian', password: 'secret123', displayName: '钱多多' });
  await other.next('welcome', (m) => m.account !== null);
  other.send({ t: 'setDisplayName', displayName: '赵老师' });
  expect((await other.next('error')).code).toBe('BAD_NAME');
  // 旧名字放出来了，游客可以用
  const g = new Client(server.port);
  await g.open();
  g.send({ t: 'hello', name: '小赵' });
  expect((await g.next('welcome')).account).toBeNull();
  // 退出登录：这台设备回首页；开局前和断线一样让座（牌局中座位留给账号、显示离线）
  c.send({ t: 'logout' });
  await c.next('loggedOut');
  c.send({ t: 'listRooms' });
  expect((await c.next('error')).code).toBe('NO_SESSION');
  expect(server.registry.rooms.get(code)!.seatOf(zhaoToken)).toBeNull();
  for (const x of [first, c, other, g]) x.ws.close();
}, 20_000);

it('管理员：只有配置的账号能管；重置密码给临时密码；停用后登出且不能再登录', async () => {
  const boss = await guest('老板');
  boss.send({ t: 'register', username: 'boss', password: 'secret123', displayName: '老板' });
  expect((await boss.next('welcome', (m) => m.account !== null)).account?.isAdmin).toBe(true);
  const plain = await guest('路人丙');
  plain.send({ t: 'adminListAccounts' });
  expect((await plain.next('error')).code).toBe('NOT_ADMIN');

  boss.send({ t: 'adminListAccounts' });
  const list = await boss.next('adminAccounts');
  expect(list.accounts.map((a) => a.username)).toEqual(['zhao', 'qian', 'boss']);
  boss.send({ t: 'adminResetPassword', username: 'zhao' });
  const temp = await boss.next('adminTempPassword');
  const z = await guest('临时二');
  z.send({ t: 'login', username: 'zhao', password: temp.password });
  await z.next('welcome', (m) => m.account !== null);

  boss.send({ t: 'adminSetDisabled', username: 'boss', disabled: true });
  expect((await boss.next('error')).code).toBe('BAD_ADMIN');
  boss.send({ t: 'adminSetDisabled', username: 'zhao', disabled: true });
  expect((await boss.next('adminAccounts')).accounts.find((a) => a.username === 'zhao')?.disabled).toBe(true);
  await z.next('loggedOut');
  const again = await guest('临时三');
  again.send({ t: 'login', username: 'zhao', password: temp.password });
  expect((await again.next('error')).message).toContain('停用');
  boss.send({ t: 'adminSetDisabled', username: 'zhao', disabled: false });
  await boss.next('adminAccounts');
  for (const x of [boss, plain, z, again]) x.ws.close();
}, 20_000);

it('牌局中换设备：第一台断开后座位还在，第二台登录接着打', async () => {
  const c = await guest('路人丁');
  c.send({ t: 'createRoom', players: 4 });
  await c.next('room', (m) => Boolean(m.room?.seats[0]));
  for (let seat = 1; seat < 4; seat++) c.send({ t: 'addBot', seat });
  await c.next('room', (m) => m.room?.seats.every(Boolean) === true);
  c.send({ t: 'start' });
  await c.next('state');
  c.send({ t: 'register', username: 'sun', password: 'secret123', displayName: '孙悟空' });
  const w = await c.next('welcome', (m) => m.account !== null);
  c.ws.close();
  const d = await guest('手机');
  d.send({ t: 'login', username: 'sun', password: 'secret123' });
  expect((await d.next('welcome', (m) => m.account !== null)).token).toBe(w.token);
  expect((await d.next('room', (m) => m.room !== null)).room).toMatchObject({ you: 0, started: true });
  expect((await d.next('state')).view.seat).toBe(0);
  d.ws.close();
}, 20_000);

it('服务器重启后账号还在，登录还是同一个会话', async () => {
  await server.close();
  server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false, snapshotDir: dir, adminUsernames: ['boss'], roomOptions });
  const c = new Client(server.port);
  await c.open();
  c.send({ t: 'login', username: 'qian', password: 'secret123' });
  const w = await c.next('welcome', (m) => m.account !== null);
  expect(w.account?.displayName).toBe('钱多多');
  c.ws.close();
}, 20_000);
