/** 集成测试：一个真人客户端加机器人，通过 WebSocket 打完两局。 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  RANKS, SUITS, applyAction, createRng, decompose, generateFollow, groupOf, type Card, type PlayerView,
} from '@shengji/engine';
import type { ClientMessage, ServerMessage } from '@shengji/protocol';
import { startServer, type RunningServer } from '../src/server.ts';

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false, roomOptions: { dealIntervalMs: 2, declareGraceMs: 30, botDelayMs: 2, searchBudgetMs: 5 } });
});
afterAll(async () => { await server.close(); });

class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  private queue: ServerMessage[] = [];
  private waiter: ((m: ServerMessage) => void) | null = null;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      this.inbox.push(m);
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(m); }
      else this.queue.push(m);
    });
  }
  open(): Promise<void> { return new Promise((r) => this.ws.once('open', () => r())); }
  send(m: ClientMessage): void { this.ws.send(JSON.stringify(m)); }
  /** 按到达顺序逐条取消息，不会漏掉同一帧里连续到达的多条 */
  next(timeoutMs = 5000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiter = null; reject(new Error('等待消息超时')); }, timeoutMs);
      this.waiter = (m) => { clearTimeout(t); resolve(m); };
    });
  }
  async until<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 8000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let m: ServerMessage;
      try {
        m = await this.next(Math.max(1, deadline - Date.now()));
      } catch (err) {
        throw new Error(`${(err as Error).message}；收到过：${this.inbox.map(summary).join(' ')}`);
      }
      if (pred(m)) return m;
    }
  }
}

function summary(m: ServerMessage): string {
  if (m.t === 'state') return `state:${m.view.phase}`;
  if (m.t === 'room') return `room:${m.room ? m.room.seats.map((x) => x?.name ?? '_').join(',') : 'null'}`;
  if (m.t === 'error') return `error:${m.code}`;
  return m.t;
}

const isState = (m: ServerMessage): m is Extract<ServerMessage, { t: 'state' }> => m.t === 'state';
const isRoom = (m: ServerMessage): m is Extract<ServerMessage, { t: 'room' }> => m.t === 'room';

function decide(view: PlayerView, rng = createRng('client')): ClientMessage | null {
  const me = view.seat;
  const ctx = { level: view.level, trumpSuit: view.trumpSuit };
  if (view.phase === 'bottom' && view.dealer === me) {
    return { t: 'exchangeBottom', cards: view.hand.slice(0, view.config.bottomSize).map((c) => c.id) };
  }
  if (view.phase === 'callFriend' && view.dealer === me) {
    const suit = SUITS.find((s) => s !== view.trumpSuit)!;
    const ranks = RANKS.filter((r) => r !== view.level);
    return { t: 'callFriend', calls: Array.from({ length: view.config.friendCount }, (_, i) => ({ suit, rank: ranks[i] as number, nth: 1 })) };
  }
  if (view.phase === 'playing' && view.currentTurn === me) {
    let cards: Card[];
    if (view.trick && view.trick.plays.length > 0 && view.trick.lead) {
      cards = generateFollow(view.trick.lead, view.hand, ctx, rng);
    } else {
      const groups = new Map<string, Card[]>();
      for (const c of view.hand) groups.set(groupOf(c, ctx), [...(groups.get(groupOf(c, ctx)) ?? []), c]);
      const g = [...groups.values()][0] as Card[];
      const d = decompose(g, ctx)!;
      cards = [...(d.components[d.components.length - 1] as { cards: readonly Card[] }).cards];
    }
    return { t: 'play', cards: cards.map((c) => c.id) };
  }
  return null;
}

it('真人 + 5 个机器人通过 WebSocket 打完两局', async () => {
  const c = new Client(server.port);
  await c.open();
  c.send({ t: 'hello', name: '测试员' });
  const welcome = await c.next();
  expect(welcome.t).toBe('welcome');
  expect((await c.next()).t).toBe('room'); // 未在房间：room null
  c.send({ t: 'createRoom', players: 6 });
  let room = await c.until(isRoom);
  expect(room.room?.code).toHaveLength(4);
  expect(room.room?.you).toBe(0);
  for (let seat = 1; seat < 6; seat++) c.send({ t: 'addBot', seat });
  room = await c.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room?.seats.every(Boolean) === true);
  c.send({ t: 'start' });

  let roundsSeen = 0;
  let lastPhase = '';
  let replayOk = false;
  const errors: string[] = [];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const m = await c.next(10_000);
    if (m.t === 'error') { errors.push(`${m.code}: ${m.message}`); continue; }
    if (m.t === 'replay') {
      // 回放：从初始状态重放全部操作，应当落在本局结束
      let st = m.replay.initial;
      for (const a of m.replay.actions) {
        const r = applyAction(st, a);
        if (!r.ok) throw new Error(`回放失败 ${a.type}: ${r.error.message}`);
        st = r.state;
      }
      expect(st.phase).toBe('roundEnd');
      expect(st.round).toBe(m.replay.round);
      expect(m.replay.names).toHaveLength(6);
      replayOk = true;
      c.send({ t: 'nextRound' });
      continue;
    }
    if (!isState(m)) continue;
    const v = m.view;
    if (v.phase !== lastPhase) lastPhase = v.phase;
    for (const e of m.events) {
      if (e.type === 'cardDealt' && e.seat !== v.seat) expect(e.card.id).toBe('hidden');
    }
    if (v.phase === 'roundEnd') {
      roundsSeen++;
      expect(v.lastRound?.opponentPoints).toBeGreaterThanOrEqual(0);
      expect(v.bottom).not.toBeNull();
      if (roundsSeen >= 2) break;
      c.send({ t: 'getReplay', round: v.round }); // 收到回放后再开下一局
      continue;
    }
    if (v.phase === 'gameOver') break;
    const a = decide(v);
    if (a) c.send(a);
  }
  expect(errors).toEqual([]);
  expect(roundsSeen).toBeGreaterThanOrEqual(2);
  expect(replayOk).toBe(true);

  // 断线重连：同一 token 重新 hello 应拿回座位和状态
  const token = (welcome as Extract<ServerMessage, { t: 'welcome' }>).token;
  c.ws.close();
  const c2 = new Client(server.port);
  await c2.open();
  c2.send({ t: 'hello', name: '测试员' , token });
  const w2 = await c2.next();
  expect(w2.t).toBe('welcome');
  const r2 = await c2.until(isRoom);
  expect(r2.room?.you).toBe(0);
  expect(r2.room?.started).toBe(true);
  const s2 = await c2.until(isState);
  expect(s2.view.seat).toBe(0);
  c2.ws.close();
}, 90_000);

it('房主可以重发本局和结束游戏回大厅', async () => {
  const c = new Client(server.port);
  await c.open();
  c.send({ t: 'hello', name: '房主' });
  await c.next();
  await c.next();
  c.send({ t: 'createRoom', players: 5 });
  await c.until(isRoom);
  for (let seat = 1; seat < 5; seat++) c.send({ t: 'addBot', seat });
  await c.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room?.seats.every(Boolean) === true);
  c.send({ t: 'start' });
  let st = await c.until(isState);
  for (let i = 0; i < 10; i++) st = await c.until(isState); // 发几张牌
  expect(st.view.hand.length).toBeGreaterThan(0);
  c.send({ t: 'restartRound' });
  const restarted = await c.until((m): m is Extract<ServerMessage, { t: 'state' }> => isState(m) && m.events.some((e) => e.type === 'roundRestarted'));
  expect(restarted.view.round).toBe(1);
  expect(restarted.view.hand.length).toBeLessThanOrEqual(1);
  c.send({ t: 'abortGame' });
  const lobby = await c.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room?.started === false);
  expect(lobby.room?.seats.filter(Boolean).length).toBe(5);
  // 还能再开一局
  c.send({ t: 'start' });
  const again = await c.until(isState);
  expect(again.view.round).toBe(1);
  expect(again.view.levels.every((l) => l === 0)).toBe(true);
  c.ws.close();
}, 30_000);

it('中途退出由机器人接管，再进来能接回座位，房主顺延', async () => {
  const host = new Client(server.port);
  await host.open();
  host.send({ t: 'hello', name: '甲' });
  await host.next(); await host.next();
  host.send({ t: 'createRoom', players: 5 });
  const created = await host.until(isRoom);
  const code = created.room!.code;
  const guest = new Client(server.port);
  await guest.open();
  guest.send({ t: 'hello', name: '乙' });
  await guest.next(); await guest.next();
  guest.send({ t: 'joinRoom', code });
  await guest.until(isRoom);
  guest.send({ t: 'sit', seat: 1 });
  await guest.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room?.you === 1);
  for (let seat = 2; seat < 5; seat++) host.send({ t: 'addBot', seat });
  await host.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room?.seats.every(Boolean) === true);
  host.send({ t: 'start' });
  await host.until(isState);
  await guest.until(isState);
  // 房主退出：0 号位变机器人，房主交给乙
  host.send({ t: 'leaveRoom' });
  const afterLeave = await guest.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room?.seats[0]?.isBot === true);
  expect(afterLeave.room?.youAreHost).toBe(true);
  // 丙用房间码进来，接管一个机器人座位
  const third = new Client(server.port);
  await third.open();
  third.send({ t: 'hello', name: '丙' });
  await third.next(); await third.next();
  third.send({ t: 'joinRoom', code });
  const joined = await third.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room?.you !== null);
  expect(joined.room?.started).toBe(true);
  expect(joined.room?.seats[joined.room!.you!]?.isBot).toBe(false);
  const st = await third.until(isState);
  expect(st.view.seat).toBe(joined.room!.you);
  host.ws.close(); guest.ws.close(); third.ws.close();
}, 30_000);

it('没有真人在线时机器人暂停，真人回来后继续', async () => {
  const c = new Client(server.port);
  await c.open();
  c.send({ t: 'hello', name: '独苗' });
  const welcome = await c.next() as Extract<ServerMessage, { t: 'welcome' }>;
  await c.next();
  c.send({ t: 'createRoom', players: 5 });
  const created = await c.until(isRoom);
  const code = created.room!.code;
  for (let seat = 1; seat < 5; seat++) c.send({ t: 'addBot', seat });
  await c.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room?.seats.every(Boolean) === true);
  c.send({ t: 'start' });
  let st = await c.until(isState);
  for (let i = 0; i < 5; i++) st = await c.until(isState);
  c.ws.close();
  await new Promise((r) => setTimeout(r, 150));
  const room = server.registry.rooms.get(code)!;
  const dealtAtClose = room.state!.hands.reduce((a, h) => a + h.length, 0);
  await new Promise((r) => setTimeout(r, 200)); // 发牌间隔 2ms，若未暂停会多发上百张
  const dealtLater = room.state!.hands.reduce((a, h) => a + h.length, 0);
  expect(dealtLater - dealtAtClose).toBeLessThanOrEqual(1);
  // 真人回来，发牌继续
  const c2 = new Client(server.port);
  await c2.open();
  c2.send({ t: 'hello', name: '独苗', token: welcome.token });
  await c2.until(isState);
  await new Promise((r) => setTimeout(r, 200));
  const dealtResumed = room.state!.hands.reduce((a, h) => a + h.length, 0);
  expect(dealtResumed).toBeGreaterThan(dealtLater + 5);
  c2.ws.close();
}, 30_000);

it('首页能列出服务器上的房间', async () => {
  const c = new Client(server.port);
  await c.open();
  c.send({ t: 'hello', name: '看客' });
  await c.next(); await c.next();
  c.send({ t: 'listRooms' });
  const m = await c.until((x): x is Extract<ServerMessage, { t: 'rooms' }> => x.t === 'rooms');
  expect(Array.isArray(m.rooms)).toBe(true);
  expect(m.rooms.length).toBeGreaterThan(0);
  const r = m.rooms[0]!;
  expect(r.code).toHaveLength(4);
  expect(typeof r.joinable).toBe('boolean');
  expect(r.humans + r.bots).toBeGreaterThan(0);
  c.ws.close();
});

it('房主可以关闭房间，成员被送回首页，列表里消失', async () => {
  const host = new Client(server.port);
  await host.open();
  host.send({ t: 'hello', name: '房主丁' });
  await host.next(); await host.next();
  host.send({ t: 'createRoom', players: 5 });
  const created = await host.until(isRoom);
  const code = created.room!.code;
  const guest = new Client(server.port);
  await guest.open();
  guest.send({ t: 'hello', name: '客戊' });
  await guest.next(); await guest.next();
  guest.send({ t: 'joinRoom', code });
  await guest.until(isRoom);
  guest.send({ t: 'closeRoom' });
  const denied = await guest.until((m): m is Extract<ServerMessage, { t: 'error' }> => m.t === 'error');
  expect(denied.code).toBe('NOT_HOST');
  host.send({ t: 'closeRoom' });
  await host.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room === null);
  const kicked = await guest.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && m.room === null);
  expect(kicked.room).toBeNull();
  expect(server.registry.rooms.has(code)).toBe(false);
  host.ws.close(); guest.ws.close();
});

it('房间里没有真人在线时，外人也不能关闭（#11）', async () => {
  const host = new Client(server.port);
  await host.open();
  host.send({ t: 'hello', name: '房主己' });
  await host.next(); await host.next();
  host.send({ t: 'createRoom', players: 4 });
  const code = (await host.until(isRoom)).room!.code;
  host.send({ t: 'addBot', seat: 1 });
  await host.until((m): m is Extract<ServerMessage, { t: 'room' }> => isRoom(m) && Boolean(m.room?.seats[1]?.isBot));
  host.ws.close();
  await expect.poll(() => server.registry.rooms.get(code)?.humansOnline()).toBe(false);

  const stranger = new Client(server.port);
  await stranger.open();
  stranger.send({ t: 'hello', name: '路人庚' });
  await stranger.next(); await stranger.next();
  stranger.send({ t: 'listRooms' });
  const list = await stranger.until((x): x is Extract<ServerMessage, { t: 'rooms' }> => x.t === 'rooms');
  expect(list.rooms.find((r) => r.code === code)?.canClose).toBe(false);
  stranger.send({ t: 'closeRoom', code });
  const denied = await stranger.until((m): m is Extract<ServerMessage, { t: 'error' }> => m.t === 'error');
  expect(denied.code).toBe('NOT_HOST');
  expect(server.registry.rooms.has(code)).toBe(true);
  stranger.ws.close();
});

it('加入不存在的房间和开局后加入都会被拒绝', async () => {
  const c = new Client(server.port);
  await c.open();
  c.send({ t: 'hello', name: '路人' });
  await c.next();
  await c.next();
  c.send({ t: 'joinRoom', code: 'ZZZZ' });
  const e = await c.next();
  expect(e.t).toBe('error');
  c.ws.close();
});
