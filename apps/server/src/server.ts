/** HTTP 静态托管 + /ws WebSocket。startServer 可在测试中以随机端口启动。 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, type ServerMessage } from '@shengji/protocol';
import { Registry } from './registry.ts';
import type { RoomOptions } from './room.ts';
import { Store } from './store.ts';
import { closeSearchPool, getSearchPool } from './searchPool.ts';

export interface ServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly roomOptions?: RoomOptions;
  readonly serveStatic?: boolean;
  /** 快照目录，不传则不落盘 */
  readonly snapshotDir?: string;
}

export interface RunningServer {
  readonly port: number;
  readonly registry: Registry;
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
const restored = registry.restore();
if (restored > 0) console.log(`从快照恢复了 ${restored} 个房间`);
getSearchPool();
const gcTimer = setInterval(() => registry.gc(), 10 * 60_000);
gcTimer.unref();

const wss = new WebSocketServer({ noServer: true });
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
  let token: string | null = null;
  const room = () => {
    if (!token) return null;
    const s = registry.sessions.get(token);
    return s?.roomCode ? registry.rooms.get(s.roomCode) ?? null : null;
  };

  ws.on('message', (data) => {
    const msg = parseClientMessage(data.toString());
    if (!msg) return send(ws, { t: 'error', code: 'BAD_MESSAGE', message: '消息格式不正确' });

    if (msg.t === 'hello') {
      const existing = msg.token ? registry.sessions.get(msg.token) : undefined;
      if (existing) {
        token = existing.token;
        existing.name = msg.name;
        existing.lastSeen = Date.now();
      } else {
        token = registry.newToken();
        registry.sessions.set(token, { token, name: msg.name, roomCode: null, lastSeen: Date.now() });
      }
      send(ws, { t: 'welcome', token, name: msg.name });
      registry.scheduleSave();
      const r = room();
      if (r) {
        r.join(token, msg.name, ws);
        r.sync(token);
        r.broadcastRoom();
      } else {
        send(ws, { t: 'room', room: null });
      }
      return;
    }

    if (!token && msg.t === 'ping') return send(ws, { t: 'pong' });
    if (!token) return send(ws, { t: 'error', code: 'NO_SESSION', message: '请先发送 hello' });
    const session = registry.sessions.get(token);
    if (!session) return send(ws, { t: 'error', code: 'NO_SESSION', message: '会话已失效，请刷新' });
    session.lastSeen = Date.now();

    switch (msg.t) {
      case 'ping': return send(ws, { t: 'pong' });
      case 'closeRoom': {
        const code = (msg.code ?? session.roomCode ?? '').toUpperCase();
        const r = registry.rooms.get(code);
        if (!r) return send(ws, { t: 'error', code: 'NO_ROOM', message: '房间不存在' });
        if (!r.canClose(session.token)) return send(ws, { t: 'error', code: 'NOT_HOST', message: '只有房主能关闭有人在线的房间' });
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
        room()?.leave(token);
        const r = registry.createRoom(token, msg.players);
        session.roomCode = r.code;
        registry.scheduleSave();
        r.join(token, session.name, ws);
        r.sit(token, 0);
        return;
      }
      case 'joinRoom': {
        const r = registry.rooms.get(msg.code.toUpperCase());
        if (!r) return send(ws, { t: 'error', code: 'NO_ROOM', message: '房间不存在' });
        const needsSeat = r.started && r.seatOf(token) === null;
        if (needsSeat && !r.seats.some((s) => s?.isBot)) {
          return send(ws, { t: 'error', code: 'STARTED', message: '这个房间已经开局，也没有机器人座位可以接管' });
        }
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
      case 'setBots': return r.setBots(token, msg.strength);
      case 'nextRound': return r.act(token, { type: 'nextRound' });
      case 'restartRound': return r.restartRound(token);
      case 'abortGame': return r.abortGame(token);
      case 'getReplay': return r.replayFor(token, msg.round);
      default: break;
    }
    if (seat === null) return send(ws, { t: 'error', code: 'NOT_SEATED', message: '你没有坐下' });
    switch (msg.t) {
      case 'declare': return r.act(token, { type: 'declare', seat, cards: msg.cards });
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
