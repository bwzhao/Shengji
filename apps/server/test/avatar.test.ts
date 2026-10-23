/** 头像：文件头检查、大小和宽高限制、存盘和重启后读回、上传后房间里看得到、HTTP 取图、管理员删头像。 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@shengji/protocol';
import { Accounts } from '../src/accounts.ts';
import { AVATAR_MAX_BYTES, checkAvatar, sniffImage } from '../src/avatarImage.ts';
import { startServer, type RunningServer } from '../src/server.ts';

// 只造文件头：检查只看格式和宽高，后面补些字节当图像数据
const pad = (head: Buffer, total = 200) => Buffer.concat([head, Buffer.alloc(Math.max(0, total - head.length), 7)]);

function png(w: number, h: number, total?: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return pad(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]), total);
}

function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(9)]);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43]), Buffer.alloc(65)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return pad(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, sof, Buffer.from([0xff, 0xda])]));
}

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number): Buffer {
  let data: Buffer;
  if (kind === 'VP8 ') {
    data = Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0, 0, 0, 0]);
    data.writeUInt16LE(w, 6);
    data.writeUInt16LE(h, 8);
  } else if (kind === 'VP8L') {
    data = Buffer.alloc(5);
    data[0] = 0x2f;
    data.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1);
  } else {
    data = Buffer.alloc(10);
    data.writeUIntLE(w - 1, 4, 3);
    data.writeUIntLE(h - 1, 7, 3);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(kind), size, data]));
}

describe('文件头检查', () => {
  it('认得 PNG、JPEG 和三种 WebP，读出宽高', () => {
    expect(sniffImage(png(160, 120))).toMatchObject({ type: 'image/png', width: 160, height: 120 });
    expect(sniffImage(jpeg(160, 90))).toMatchObject({ type: 'image/jpeg', ext: 'jpg', width: 160, height: 90 });
    expect(sniffImage(webp('VP8 ', 160, 161))).toMatchObject({ type: 'image/webp', width: 160, height: 161 });
    expect(sniffImage(webp('VP8L', 160, 162))).toMatchObject({ type: 'image/webp', width: 160, height: 162 });
    expect(sniffImage(webp('VP8X', 160, 163))).toMatchObject({ type: 'image/webp', width: 160, height: 163 });
  });

  it('不收 SVG、GIF、空文件、太大的文件和宽高太大的图', () => {
    expect(checkAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBe('只支持 JPG、PNG、WebP 格式的图片');
    expect(checkAvatar(pad(Buffer.from('GIF89a')))).toBe('只支持 JPG、PNG、WebP 格式的图片');
    expect(checkAvatar(Buffer.alloc(0))).toBe('没收到图片');
    expect(checkAvatar(png(160, 160, AVATAR_MAX_BYTES + 1))).toMatch(/太大/);
    expect(checkAvatar(png(160, 160, AVATAR_MAX_BYTES))).toMatchObject({ type: 'image/png' });
    // 64 KB 以内的图也可能解码成很大的位图，会卡住别人的浏览器
    expect(checkAvatar(png(20000, 20000))).toMatch(/512 像素/);
    expect(checkAvatar(webp('VP8X', 513, 100))).toMatch(/512 像素/);
    expect(checkAvatar(png(0, 160))).toMatch(/512 像素/);
  });
});

describe('存盘', () => {
  it('换头像写盘，重启后读回；换格式、删掉时旧文件跟着删', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avatar-store-'));
    const acc = new Accounts(dir);
    const r = acc.register('zhao', 'secret123', '小赵');
    if (!r.ok) throw new Error(r.message);
    const id = r.account.id;
    expect(acc.info(r.account).avatar).toBeNull();

    const pic = png(160, 160);
    expect(acc.setAvatar(r.account, pic)).toBeNull();
    const url = acc.avatarUrl(id);
    expect(url).toMatch(new RegExp(`^/avatar/${id}\\?v=[0-9a-f]{12}$`));
    expect(readdirSync(join(dir, 'avatars'))).toEqual([`${id}.png`]);

    const again = new Accounts(dir);
    expect(again.avatarUrl(id)).toBe(url);
    expect(again.avatarFile(id)?.data.equals(pic)).toBe(true);
    expect(again.avatarFile(id)?.type).toBe('image/png');

    // 不合格的不动原来的头像
    expect(acc.setAvatar(r.account, Buffer.from('<svg/>'))).toMatch(/格式/);
    expect(acc.avatarUrl(id)).toBe(url);

    expect(acc.setAvatar(r.account, webp('VP8X', 160, 160))).toBeNull();
    expect(acc.avatarUrl(id)).not.toBe(url);
    expect(readdirSync(join(dir, 'avatars'))).toEqual([`${id}.webp`]);

    expect(acc.setAvatar(r.account, null)).toBeNull();
    expect(acc.avatarUrl(id)).toBeNull();
    expect(readdirSync(join(dir, 'avatars'))).toEqual([]);
    expect(new Accounts(dir).avatarUrl(id)).toBeNull();
  });

  it('头像文件丢了就当没有头像', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avatar-lost-'));
    const acc = new Accounts(dir);
    const r = acc.register('qian', 'secret123', '小钱');
    if (!r.ok) throw new Error(r.message);
    acc.setAvatar(r.account, jpeg(160, 160));
    const file = join(dir, 'avatars', `${r.account.id}.jpg`);
    expect(existsSync(file)).toBe(true);
    // 模拟卷上的文件没了
    rmSync(file);
    expect(new Accounts(dir).avatarUrl(r.account.id)).toBeNull();
  });
});

describe('上传和显示', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-ws-'));
  let server: RunningServer;
  beforeAll(async () => { server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false, snapshotDir: dir, adminUsernames: ['boss'] }); });
  afterAll(async () => { await server.close(); });

  class Client {
    readonly ws: WebSocket;
    readonly inbox: ServerMessage[] = [];
    closeCode: number | null = null;
    private seen = 0;
    constructor() {
      this.ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      this.ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString()) as ServerMessage));
      this.ws.on('close', (code) => { this.closeCode = code; });
    }
    open(): Promise<void> { return new Promise((r) => this.ws.once('open', () => r())); }
    send(m: ClientMessage): void { this.ws.send(JSON.stringify(m)); }
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

  async function connect(): Promise<Client> {
    const c = new Client();
    await c.open();
    return c;
  }

  let url = '';
  let zhao: Client;
  let pic: Buffer;

  it('游客不能上传头像', async () => {
    const c = await connect();
    c.send({ t: 'hello', name: '路人' });
    await c.next('welcome');
    c.send({ t: 'setAvatar', data: png(160, 160).toString('base64') });
    expect((await c.next('error')).code).toBe('NOT_LOGGED_IN');
    c.ws.close();
  });

  it('注册用户上传头像：账号和房间座位都带上头像网址，同房间的人也看得到', async () => {
    zhao = await connect();
    zhao.send({ t: 'register', username: 'zhao', password: 'secret123', displayName: '小赵' });
    expect((await zhao.next('welcome')).account?.avatar).toBeNull();
    zhao.send({ t: 'createRoom', players: 4 });
    const room = await zhao.next('room', (m) => Boolean(m.room?.seats[0]));
    expect(room.room!.seats[0]!.avatar).toBeNull();

    const other = await connect();
    other.send({ t: 'hello', name: '小钱' });
    await other.next('welcome');
    other.send({ t: 'joinRoom', code: room.room!.code });
    await other.next('room');
    other.send({ t: 'sit', seat: 1 });
    await other.next('room', (m) => m.room?.seats[1]?.name === '小钱');

    pic = png(160, 160);
    zhao.send({ t: 'setAvatar', data: pic.toString('base64') });
    const acc = await zhao.next('account');
    url = acc.account.avatar ?? '';
    expect(url).toMatch(/^\/avatar\/[\w-]+\?v=[0-9a-f]{12}$/);
    const seen = await other.next('room', (m) => Boolean(m.room?.seats[0]?.avatar));
    expect(seen.room!.seats[0]!.avatar).toBe(url);
    // 游客没有头像
    expect(seen.room!.seats[1]!.avatar).toBeNull();
    other.ws.close();
  });

  it('HTTP 取头像：类型对、不让浏览器猜类型、带哈希的网址长期缓存', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}${url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await res.arrayBuffer()).equals(pic)).toBe(true);

    const stale = await fetch(`http://127.0.0.1:${server.port}${url.split('?')[0]}?v=old`);
    expect(stale.status).toBe(200);
    expect(stale.headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(`http://127.0.0.1:${server.port}/avatar/nobody`)).status).toBe(404);
  });

  it('不合格的图片给提示，头像不变', async () => {
    zhao.send({ t: 'setAvatar', data: Buffer.from('<svg/>').toString('base64') });
    const e = await zhao.next('error');
    expect(e.code).toBe('BAD_AVATAR');
    expect(server.accounts.avatarUrl(server.accounts.find('zhao')!.id)).toBe(url);
  });

  it('管理员删掉头像：本人和房间里马上变回名字首字', async () => {
    const boss = await connect();
    boss.send({ t: 'register', username: 'boss', password: 'secret123', displayName: '老板' });
    await boss.next('welcome');
    boss.send({ t: 'adminRemoveAvatar', username: 'zhao' });
    const list = await boss.next('adminAccounts');
    expect(list.accounts.find((a) => a.username === 'zhao')?.avatar).toBeNull();
    // 先广播房间再发账号
    await zhao.next('room', (m) => m.room?.seats[0]?.avatar === null);
    expect((await zhao.next('account')).account.avatar).toBeNull();
    expect((await fetch(`http://127.0.0.1:${server.port}${url}`)).status).toBe(404);
    boss.ws.close();
  });

  it('不是管理员不能删别人的头像', async () => {
    zhao.send({ t: 'adminRemoveAvatar', username: 'boss' });
    expect((await zhao.next('error')).code).toBe('NOT_ADMIN');
  });

  it('自己删头像', async () => {
    zhao.send({ t: 'setAvatar', data: jpeg(160, 160).toString('base64') });
    expect((await zhao.next('account')).account.avatar).toMatch(/^\/avatar\//);
    zhao.send({ t: 'setAvatar', data: null });
    expect((await zhao.next('account')).account.avatar).toBeNull();
  });

  it('超过 256 KB 的消息直接断开连接', async () => {
    const c = await connect();
    c.ws.send('x'.repeat(300 * 1024));
    const deadline = Date.now() + 5000;
    while (c.closeCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(c.closeCode).toBe(1009);
    zhao.ws.close();
  });
});
