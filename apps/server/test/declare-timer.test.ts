/** 发完牌后的亮主思考时间：30 秒，有人亮主、加固或反主就重新计时（issue #12）。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { applyAction, createGame, createRng, declarationCandidates, defaultConfig, smartDeclare, type Action, type GameState } from '@shengji/engine';
import type { ServerMessage } from '@shengji/protocol';
import { Room } from '../src/room.ts';

const GRACE = 30_000;
const opts = { dealIntervalMs: 5, declareGraceMs: GRACE, botDelayMs: 900, searchBudgetMs: 5 };

type StateMsg = Extract<ServerMessage, { t: 'state' }>;

function fakeSocket(inbox: ServerMessage[]): WebSocket & { readyState: number } {
  return { OPEN: 1, readyState: 1, send: (d: string) => inbox.push(JSON.parse(d) as ServerMessage) } as unknown as WebSocket & { readyState: number };
}

function lastState(inbox: readonly ServerMessage[]): StateMsg {
  const m = [...inbox].reverse().find((x): x is StateMsg => x.t === 'state');
  if (!m) throw new Error('没收到 state');
  return m;
}

function step(s: GameState, a: Action): GameState {
  const r = applyAction(s, a);
  if (!r.ok) throw new Error(r.error.message);
  return r.state;
}

/** 首局发完牌、还没人亮主的局面；declarable 时挑 0 号位手里能亮的牌 */
function dealt(declarable: boolean): { state: GameState; cards: string[] } {
  for (let k = 0; ; k++) {
    let st = createGame(defaultConfig(4), `declare-timer-${k}`);
    while (st.phase === 'dealing') st = step(st, { type: 'dealCard' });
    const options = declarationCandidates(st.hands[0] ?? [], st, 0);
    if (!declarable) return { state: st, cards: [] };
    if (options[0]) return { state: st, cards: options[0].map((c) => c.id) };
  }
}

/** 四个真人坐满（没有机器人，免得机器人亮主打乱计时），直接摆上发完牌的局面 */
function setup(state: GameState): { room: Room; inbox: ServerMessage[]; socket: ReturnType<typeof fakeSocket> } {
  const room = new Room('TEST', 4, 'h0', opts);
  const inbox: ServerMessage[] = [];
  const socket = fakeSocket(inbox);
  for (let i = 0; i < 4; i++) {
    room.join(`h${i}`, `玩家${i}`, i === 0 ? socket : fakeSocket([]));
    room.sit(`h${i}`, i);
  }
  room.state = state;
  room.resume();
  return { room, inbox, socket };
}

let rooms: Room[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const r of rooms) r.dispose(); rooms = []; vi.useRealTimers(); });

it('发完牌给 30 秒，有人亮主就重新计时，到时拿底牌', () => {
  const { state, cards } = dealt(true);
  const { room, inbox } = setup(state);
  rooms.push(room);
  expect(room.state?.phase).toBe('declaring');
  expect(lastState(inbox).declareLeftMs).toBe(GRACE);

  vi.advanceTimersByTime(20_000);
  expect(room.state?.phase).toBe('declaring');
  room.act('h0', { type: 'declare', seat: 0, cards });
  expect(room.state?.declaration?.seat).toBe(0);
  expect(lastState(inbox).declareLeftMs).toBe(GRACE);

  // 不重新计时的话 10 秒后就该结束了
  vi.advanceTimersByTime(GRACE - 1);
  expect(room.state?.phase).toBe('declaring');
  vi.advanceTimersByTime(1);
  expect(room.state?.phase).toBe('bottom');
  expect(lastState(inbox).declareLeftMs).toBeUndefined();
});

it('无人亮主也等满 30 秒，首局到时重新发牌', () => {
  const { room, inbox } = setup(dealt(false).state);
  rooms.push(room);
  vi.advanceTimersByTime(GRACE - 1);
  expect(room.state?.phase).toBe('declaring');
  vi.advanceTimersByTime(1);
  expect(room.state?.phase).toBe('dealing');
  expect(room.state?.redeals).toBe(1);
  expect(lastState(inbox).declareLeftMs).toBeUndefined();
});

it('没有真人在线时暂停，真人回来重新给满 30 秒', () => {
  const room = new Room('TEST', 4, 'h0', opts);
  rooms.push(room);
  const inbox: ServerMessage[] = [];
  const socket = fakeSocket(inbox);
  room.join('h0', '玩家0', socket);
  room.sit('h0', 0);
  for (let i = 1; i < 4; i++) { room.join(`h${i}`, `玩家${i}`, null); room.sit(`h${i}`, i); }
  room.state = dealt(false).state;
  room.resume();

  socket.readyState = 3; // 掉线
  vi.advanceTimersByTime(GRACE * 3);
  expect(room.state?.phase).toBe('declaring');

  const back: ServerMessage[] = [];
  room.join('h0', '玩家0', fakeSocket(back));
  room.sync('h0');
  expect(lastState(back).declareLeftMs).toBe(GRACE);
  vi.advanceTimersByTime(GRACE - 1);
  expect(room.state?.phase).toBe('declaring');
  vi.advanceTimersByTime(1);
  expect(room.state?.phase).toBe('dealing');
});

it('机器人亮主也重新计时，而且不等倒计时结束就考虑', () => {
  // 找一个发完牌后有机器人（1 到 3 号位）想亮主的局面
  let state: GameState | null = null;
  for (let k = 0; !state; k++) {
    let st = createGame(defaultConfig(4), `declare-bot-${k}`);
    while (st.phase === 'dealing') st = step(st, { type: 'dealCard' });
    if ([1, 2, 3].some((seat) => smartDeclare(st, seat, createRng('x')))) state = st;
  }
  const room = new Room('TEST', 4, 'h0', opts);
  rooms.push(room);
  room.botStrength = 'normal';
  const inbox: ServerMessage[] = [];
  room.join('h0', '玩家0', fakeSocket(inbox));
  room.sit('h0', 0);
  for (let i = 1; i < 4; i++) room.addBot('h0', i);
  room.state = state;
  room.resume();
  expect(room.state?.declaration).toBeNull();

  vi.advanceTimersByTime(opts.botDelayMs);
  expect(room.state?.declaration?.seat).toBeGreaterThan(0);
  expect(room.state?.phase).toBe('declaring');
  expect(lastState(inbox).declareLeftMs).toBe(GRACE);
  // 从机器人亮主那一刻重新计 30 秒（之后机器人可能再反，也会再重新计时）
  vi.advanceTimersByTime(GRACE - 1);
  expect(room.state?.phase).toBe('declaring');
});
