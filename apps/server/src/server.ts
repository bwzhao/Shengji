/** HTTP 静态托管 + /ws WebSocket。startServer 可在测试中以随机端口启动。 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, type ServerMessage } from '@shengji/protocol';
import { Accounts, type Account } from './accounts.ts';
import { DdzRoom } from './ddzRoom.ts';
import { Registry } from './registry.ts';
import { Room, type RoomOptions } from './room.ts';
import { Store } from './store.ts';
import { closeSearchPool, getSearchPool } from './searchPool.ts';

export interface ServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly roomOptions?: RoomOptions;
  readonly serveStatic?: boolean;
  /** 快照目录，不传则不落盘（账号也存在这里） */
  readonly snapshotDir?: string;
  /** 管理员的登录名 */
  readonly adminUsernames?: readonly string[];
}

export interface RunningServer {
  readonly port: number;
  readonly registry: Registry;
  readonly accounts: Accounts;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, '../../web/dist');

const app = Fastify({ logger: false });
app.get('/healthz', async () => ({ ok: true }));
if (options.serveStatic !== false && existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
}

const store = options.snapshotDir ? new Store(options.snapshotDir) : null;
const registry = new Registry(options.roomOptions, store);
const accounts = new Accounts(options.snapshotDir ?? null, options.adminUsernames ?? []);
registry.accountAvatar = (id) => accounts.avatarUrl(id);
const restored = registry.restore();
if (restored > 0) console.log(`从快照恢复了 ${restored} 个房间`);
getSearchPool();
const gcTimer = setInterval(() => registry.gc(), 10 * 60_000);
gcTimer.unref();

/** 头像图片：网址带着内容哈希，哈希对得上就让浏览器一直缓存 */
app.get<{ Params: { id: string }; Querystring: { v?: string } }>('/avatar/:id', async (req, reply) => {
  const file = accounts.avatarFile(req.params.id);
  if (!file) return reply.code(404).send();
  return reply
    .header('Content-Type', file.type)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', req.query.v === file.version ? 'public, max-age=31536000, immutable' : 'no-cache')
    .send(file.data);
});

// 最大的消息是上传头像（base64 后不到 90 KB），其余都很小
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
type AliveSocket = WebSocket & { isAlive?: boolean };
const heartbeat = setInterval(() => {
  for (const c of wss.clients as Set<AliveSocket>) {
    if (c.isAlive === false) { c.terminate(); continue; }
    c.isAlive = false;
    c.ping();
  }
}, 30_000);
heartbeat.unref();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws: AliveSocket) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // 消息太大或帧格式不对：ws 会自己断开这条连接，这里接住错误，不让整个服务端崩掉
  ws.on('error', () => {});
  let token: string | null = null;
  /** 这条连接试过几次登录：和每个登录名输错 5 次锁 1 分钟一起防猜密码 */
  let loginAttempts = 0;
  /** 这条连接换了几次头像：每次都要写盘，不让一直刷 */
  let avatarUploads = 0;
  const room = () => {
    if (!token) return null;
    const s = registry.sessions.get(token);
    return s?.roomCode ? registry.rooms.get(s.roomCode) ?? null : null;
  };

  /** 这条连接用会话 t：发 welcome，再补发房间和牌局 */
  const enter = (t: string, name: string, account: Account | undefined) => {
    token = t;
    send(ws, { t: 'welcome', token: t, name, account: account ? accounts.info(account) : null });
    registry.scheduleSave();
    const r = room();
    if (r) {
      r.join(t, name, ws);
      r.sync(t);
      r.broadcastRoom();
    } else {
      send(ws, { t: 'room', room: null });
    }
  };

  /**
   * 登录或注册成功：这台设备改用账号的会话，座位和房主身份跟着账号走。
   * 第一次注册的游客直接沿用自己的会话；账号已有会话时，游客的座位在账号不在任何房间时带过去，否则游客退出房间。
   */
  const signIn = (account: Account) => {
    const prev = token ? registry.sessions.get(token) : undefined;
    if (!account.token) accounts.setToken(account, prev && !prev.accountId ? prev.token : registry.newToken());
    const accToken = account.token as string;
    let session = registry.sessions.get(accToken);
    if (!session) {
      session = { token: accToken, name: account.displayName, roomCode: null, lastSeen: Date.now() };
      registry.sessions.set(accToken, session);
    }
    session.accountId = account.id;
    session.name = account.displayName;
    session.lastSeen = Date.now();
    if (prev && prev.token !== accToken) {
      const prevRoom = prev.roomCode ? registry.rooms.get(prev.roomCode) : undefined;
      if (prevRoom && prev.accountId) prevRoom.detach(prev.token, ws);
      else if (prevRoom && !session.roomCode) { prevRoom.replaceToken(prev.token, accToken); session.roomCode = prevRoom.code; }
      else prevRoom?.leave(prev.token);
      if (!prev.accountId) registry.sessions.delete(prev.token);
    }
    // 游客时的名字换成账号的显示名字
    if (session.roomCode) registry.rooms.get(session.roomCode)?.renameMember(accToken, account.displayName);
    enter(accToken, account.displayName, account);
  };

  ws.on('message', (data) => {
    const msg = parseClientMessage(data.toString());
    if (!msg) return send(ws, { t: 'error', code: 'BAD_MESSAGE', message: '消息格式不正确' });

    if (msg.t === 'hello') {
      let existing = msg.token ? registry.sessions.get(msg.token) : undefined;
      const account = existing?.accountId ? accounts.get(existing.accountId) : undefined;
      // 登录过的设备：名字用账号的显示名字
      if (existing && account && !account.disabled) {
        existing.name = account.displayName;
        existing.lastSeen = Date.now();
        return enter(existing.token, account.displayName, account);
      }
      // 账号被停用了：这台设备当作新来的游客
      if (existing?.accountId) existing = undefined;
      if (accounts.nameTaken(msg.name)) {
        return send(ws, { t: 'error', code: 'NAME_TAKEN', message: `「${msg.name}」是已注册账号的显示名字，请换一个名字，或者登录这个账号` });
      }
      if (existing) {
        existing.name = msg.name;
        existing.lastSeen = Date.now();
      } else {
        existing = { token: registry.newToken(), name: msg.name, roomCode: null, lastSeen: Date.now() };
        registry.sessions.set(existing.token, existing);
      }
      return enter(existing.token, msg.name, undefined);
    }
    if (msg.t === 'register' || msg.t === 'login') {
      if (++loginAttempts > 20) return send(ws, { t: 'error', code: 'TOO_MANY', message: '试得太多了，刷新页面后再试' });
      const r = msg.t === 'register' ? accounts.register(msg.username, msg.password, msg.displayName) : accounts.login(msg.username, msg.password);
      if (!r.ok) return send(ws, { t: 'error', code: msg.t === 'register' ? 'REGISTER_FAILED' : 'LOGIN_FAILED', message: r.message });
      return signIn(r.account);
    }

    if (!token && msg.t === 'ping') return send(ws, { t: 'pong' });
    if (!token) return send(ws, { t: 'error', code: 'NO_SESSION', message: '请先发送 hello' });
    const session = registry.sessions.get(token);
    if (!session) return send(ws, { t: 'error', code: 'NO_SESSION', message: '会话已失效，请刷新' });
    session.lastSeen = Date.now();

    const account = session.accountId ? accounts.get(session.accountId) : undefined;
    switch (msg.t) {
      case 'ping': return send(ws, { t: 'pong' });
      case 'logout': {
        if (!account) return send(ws, { t: 'error', code: 'NOT_LOGGED_IN', message: '你还没有登录' });
        // 这台设备回到首页当游客；牌局中座位留给账号（显示离线），开局前和断线一样让座
        room()?.detach(token, ws);
        token = null;
        return send(ws, { t: 'loggedOut' });
      }
      case 'setDisplayName': {
        if (!account) return send(ws, { t: 'error', code: 'NOT_LOGGED_IN', message: '登录后才能改显示名字' });
        const err = accounts.setDisplayName(account, msg.displayName);
        if (err) return send(ws, { t: 'error', code: 'BAD_NAME', message: err });
        session.name = account.displayName;
        room()?.renameMember(token, account.displayName);
        registry.scheduleSave();
        return send(ws, { t: 'account', account: accounts.info(account) });
      }
      case 'changePassword': {
        if (!account) return send(ws, { t: 'error', code: 'NOT_LOGGED_IN', message: '你还没有登录' });
        const err = accounts.changePassword(account, msg.oldPassword, msg.newPassword);
        if (err) return send(ws, { t: 'error', code: 'BAD_PASSWORD', message: err });
        return send(ws, { t: 'notice', message: '密码改好了' });
      }
      case 'setAvatar': {
        if (!account) return send(ws, { t: 'error', code: 'NOT_LOGGED_IN', message: '注册登录后才能上传头像' });
        if (++avatarUploads > 30) return send(ws, { t: 'error', code: 'TOO_MANY', message: '换得太频繁了，刷新页面后再试' });
        const err = accounts.setAvatar(account, msg.data === null ? null : Buffer.from(msg.data, 'base64'));
        if (err) return send(ws, { t: 'error', code: 'BAD_AVATAR', message: err });
        room()?.broadcastRoom();
        return send(ws, { t: 'account', account: accounts.info(account) });
      }
      case 'adminListAccounts':
      case 'adminResetPassword':
      case 'adminSetDisabled':
      case 'adminRemoveAvatar': {
        if (!account || !accounts.isAdmin(account)) return send(ws, { t: 'error', code: 'NOT_ADMIN', message: '只有管理员能管理账号' });
        if (msg.t === 'adminResetPassword') {
          const pw = accounts.resetPassword(msg.username);
          if (!pw) return send(ws, { t: 'error', code: 'NO_ACCOUNT', message: '没有这个账号' });
          return send(ws, { t: 'adminTempPassword', username: msg.username.toLowerCase(), password: pw });
        }
        if (msg.t === 'adminRemoveAvatar') {
          const target = accounts.find(msg.username);
          if (!target) return send(ws, { t: 'error', code: 'NO_ACCOUNT', message: '没有这个账号' });
          accounts.setAvatar(target, null);
          // 牌桌上马上换回名字首字；本人在房间里的话首页的账号栏也跟着变
          for (const r of registry.roomsOfAccount(target.id)) {
            r.broadcastRoom();
            const m = target.token ? r.members.get(target.token) : undefined;
            if (m?.socket) send(m.socket, { t: 'account', account: accounts.info(target) });
          }
        }
        if (msg.t === 'adminSetDisabled') {
          if (msg.username.toLowerCase() === account.username) return send(ws, { t: 'error', code: 'BAD_ADMIN', message: '不能停用自己的账号' });
          const target = accounts.setDisabled(msg.username, msg.disabled);
          if (!target) return send(ws, { t: 'error', code: 'NO_ACCOUNT', message: '没有这个账号' });
          // 停用：登出这个账号的所有设备，座位留着显示离线
          if (msg.disabled) {
            for (const [t, s] of registry.sessions) {
              if (s.accountId !== target.id) continue;
              const m = s.roomCode ? registry.rooms.get(s.roomCode)?.members.get(t) : undefined;
              if (m?.socket) send(m.socket, { t: 'loggedOut' });
              registry.sessions.delete(t);
            }
            registry.scheduleSave();
          }
        }
        return send(ws, { t: 'adminAccounts', accounts: accounts.list() });
      }
      case 'closeRoom': {
        const code = (msg.code ?? session.roomCode ?? '').toUpperCase();
        const r = registry.rooms.get(code);
        if (!r) return send(ws, { t: 'error', code: 'NO_ROOM', message: '房间不存在' });
        if (!r.canClose(session.token)) return send(ws, { t: 'error', code: 'NOT_HOST', message: '只有房主能关闭房间' });
        const who = session.name;
        registry.closeRoom(code, `${who} 关闭了房间 ${code}`);
        return send(ws, { t: 'room', room: null });
      }
      case 'listRooms': {
        const rooms = [...registry.rooms.values()]
          .map((r) => r.summary(session.token))
          .filter((r) => r.humans > 0 || r.bots > 0)
          .sort((a, b) => b.lastActivity - a.lastActivity)
          .slice(0, 20);
        return send(ws, { t: 'rooms', rooms });
      }
      case 'createRoom': {
        const rulesErr = msg.players !== 3 && msg.rules ? Room.rulesError(msg.players, msg.rules) : null;
        if (rulesErr) return send(ws, { t: 'error', code: 'BAD_RULES', message: rulesErr });
        room()?.leave(token);
        const r = registry.createRoom(token, msg.players, msg.rules);
        session.roomCode = r.code;
        registry.scheduleSave();
        r.join(token, session.name, ws);
        r.sit(token, 0);
        return;
      }
      case 'joinRoom': {
        const r = registry.rooms.get(msg.code.toUpperCase());
        if (!r) return send(ws, { t: 'error', code: 'NO_ROOM', message: '房间不存在' });
        // 开局后进来：要观看、或者没有机器人座位可接管，就进来观看；否则接管一个机器人座位
        const needsSeat = r.started && r.seatOf(token) === null && msg.watch !== true && r.seats.some((s) => s?.isBot);
        const prev = room();
        if (prev && prev !== r) prev.leave(token);
        session.roomCode = r.code;
        r.join(token, session.name, ws);
        if (needsSeat) r.takeoverBot(token);
        r.sync(token);
        r.broadcastRoom();
        return;
      }
      case 'leaveRoom': {
        room()?.leave(token);
        session.roomCode = null;
        registry.scheduleSave();
        return send(ws, { t: 'room', room: null });
      }
    }

    const r = room();
    if (!r) return send(ws, { t: 'error', code: 'NO_ROOM', message: '你还没有进入房间' });
    const seat = r.seatOf(token);
    switch (msg.t) {
      case 'sit': return r.sit(token, msg.seat);
      case 'stand': return r.stand(token);
      case 'addBot': return r.addBot(token, msg.seat);
      case 'removeBot': return r.removeBot(token, msg.seat);
      case 'start': return r.start(token);
      case 'watch': return r.watch(token, msg.seat);
      case 'nextRound': return r.nextRound(token);
      case 'abortGame': return r.abortGame(token);
      default: break;
    }
    if (r instanceof DdzRoom) {
      if (seat === null) return send(ws, { t: 'error', code: 'NOT_SEATED', message: '你没有坐下' });
      switch (msg.t) {
        case 'bid': return r.act(token, { type: 'bid', seat, points: msg.points });
        case 'ddzPlay': return r.act(token, { type: 'play', seat, cards: msg.cards });
        case 'ddzPass': return r.act(token, { type: 'pass', seat });
        default: return send(ws, { t: 'error', code: 'WRONG_GAME', message: '斗地主房间里不能这样操作' });
      }
    }
    if (!(r instanceof Room)) return;
    switch (msg.t) {
      case 'setBots': return r.setBots(token, msg.strength);
      case 'setPlayLog': return r.setPlayLog(token, msg.open);
      case 'setRules': return r.setRules(token, msg.rules);
      case 'restartRound': return r.restartRound(token);
      case 'getReplay': return r.replayFor(token, msg.round);
      default: break;
    }
    if (seat === null) return send(ws, { t: 'error', code: 'NOT_SEATED', message: '你没有坐下' });
    switch (msg.t) {
      case 'declare': return r.act(token, { type: 'declare', seat, cards: msg.cards });
      case 'passDeclare': return r.passDeclare(token);
      case 'chaodi': return r.act(token, { type: 'chaodi', seat, cards: msg.cards });
      case 'passChaodi': return r.act(token, { type: 'passChaodi', seat });
      case 'guohe': return r.act(token, { type: 'guohe', seat, cards: msg.cards });
      case 'guoheReturn': return r.act(token, { type: 'guoheReturn', seat, cards: msg.cards });
      case 'passGuohe': return r.act(token, { type: 'passGuohe', seat });
      case 'zaofan': return r.act(token, { type: 'zaofan', seat });
      case 'passZaofan': return r.passZaofan(token);
      case 'exchangeBottom': return r.act(token, { type: 'exchangeBottom', seat, cards: msg.cards });
      case 'callFriend': return r.act(token, { type: 'callFriend', seat, calls: msg.calls });
      case 'play': return r.act(token, { type: 'play', seat, cards: msg.cards });
    }
  });

  ws.on('close', () => {
    if (token) room()?.detach(token, ws);
  });
});

app.server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws' || req.url?.startsWith('/ws?')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

await app.listen({ port: options.port, host: options.host ?? '0.0.0.0' });
const addr = app.server.address();
const port = typeof addr === 'object' && addr ? addr.port : options.port;
return {
  port,
  registry,
  accounts,
  staticDir: existsSync(webDist) ? webDist : null,
  async close() {
    clearInterval(gcTimer);
    clearInterval(heartbeat);
    registry.flush();
    await closeSearchPool();
    for (const r of registry.rooms.values()) r.dispose();
    for (const c of wss.clients) c.terminate();
    wss.close();
    await app.close();
  },
} as RunningServer & { staticDir: string | null };
}
