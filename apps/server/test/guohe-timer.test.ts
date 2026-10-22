/** 四人过河的计时：能过河的人共用 60 秒，到时当作不过；给牌还牌不计时；机器人对家自动还牌（issue #7）。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { applyAction, createGame, ctxOf, declarationCandidates, defaultConfig, isTrump, type Action, type GameState, type Seat } from '@shengji/engine';
import type { ServerMessage } from '@shengji/protocol';
import { Room } from '../src/room.ts';

const GRACE = 60_000;
const opts = { dealIntervalMs: 5, declareGraceMs: 30_000, chaodiGraceMs: 30_000, guoheGraceMs: GRACE, botDelayMs: 900, searchBudgetMs: 5 };

type StateMsg = Extract<ServerMessage, { t: 'state' }>;

function fakeSocket(inbox: ServerMessage[]): WebSocket {
  return { OPEN: 1, readyState: 1, send: (d: string) => inbox.push(JSON.parse(d) as ServerMessage) } as unknown as WebSocket;
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

/** 和庄家换牌，让 seat 手里正好 n 张主 */
function setTrumps(s: GameState, dealer: Seat, seat: Seat, n: number): GameState {
  const hands = s.hands.map((h) => [...h]);
  const ctx = ctxOf(s);
  const count = () => hands[seat]!.filter((c) => isTrump(c, ctx)).length;
  while (count() !== n) {
    const giveTrump = count() > n;
    const i = hands[seat]!.findIndex((c) => isTrump(c, ctx) === giveTrump);
    const j = hands[dealer]!.findIndex((c) => isTrump(c, ctx) !== giveTrump);
    [hands[seat]![i], hands[dealer]![j]] = [hands[dealer]![j]!, hands[seat]![i]!];
  }
  return { ...s, hands };
}

/** 首局 1 号位亮花色坐庄、埋完底；0 号位 3 张主、2 号位 4 张主、3 号位 9 张主，抄底都不抄，问 0、2 号位过不过河 */
function guoheState(): GameState {
  for (let k = 0; ; k++) {
    let s = createGame(defaultConfig(4), `guohe-timer-${k}`);
    while (s.phase === 'dealing') s = step(s, { type: 'dealCard' });
    const option = declarationCandidates(s.hands[1] ?? [], s, 1).find((o) => o[0]!.suit !== 'J');
    if (!option) continue;
    s = step(s, { type: 'declare', seat: 1, cards: option.map((c) => c.id) });
    s = step(s, { type: 'closeDeclaring' });
    s = step(s, { type: 'exchangeBottom', seat: 1, cards: s.hands[1]!.filter((c) => !isTrump(c, ctxOf(s))).slice(0, 8).map((c) => c.id) });
    s = setTrumps(setTrumps(setTrumps(s, 1, 0, 3), 1, 2, 4), 1, 3, 9);
    while (s.phase === 'chaodi') s = step(s, { type: 'passChaodi', seat: s.chaodi!.queue[0]! });
    if (s.phase !== 'guohe') throw new Error(`没进过河：${s.phase}`);
    return s;
  }
}

let room: Room;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { room.dispose(); vi.useRealTimers(); });

/** 四个座位坐满真人，bots 里的座位换成机器人 */
function setup(bots: number[] = []): ServerMessage[] {
  room = new Room('TEST', 4, 'h0', opts);
  const inbox: ServerMessage[] = [];
  for (let i = 0; i < 4; i++) {
    room.join(`h${i}`, `玩家${i}`, i === 1 ? fakeSocket(inbox) : fakeSocket([]));
    room.sit(`h${i}`, i);
  }
  for (const b of bots) { room.leave(`h${b}`); room.addBot('h0', b); }
  room.state = guoheState();
  room.resume();
  return inbox;
}

const plainIds = (seat: Seat, n: number) => room.state!.hands[seat]!.filter((c) => !isTrump(c, ctxOf(room.state!))).slice(0, n).map((c) => c.id);
const giveIds = (seat: Seat) => {
  const hand = room.state!.hands[seat]!;
  const ctx = ctxOf(room.state!);
  return [...hand.filter((c) => isTrump(c, ctx)), ...hand.filter((c) => !isTrump(c, ctx))].slice(0, 5).map((c) => c.id);
};

it('能过河的人共用 60 秒，有人决定了也不重新计时，到时没决定的当作不过', () => {
  const inbox = setup();
  expect(room.state?.guohe?.asked).toEqual([0, 2]);
  expect(lastState(inbox).guoheLeftMs).toBe(GRACE);
  vi.advanceTimersByTime(30_000);
  room.act('h2', { type: 'passGuohe', seat: 2 });
  expect(lastState(inbox).guoheLeftMs).toBe(GRACE - 30_000);
  vi.advanceTimersByTime(GRACE - 30_000 - 1);
  expect(room.state?.phase).toBe('guohe');
  vi.advanceTimersByTime(1);
  expect(room.state?.phase).toBe('playing');
  expect(lastState(inbox).guoheLeftMs).toBeUndefined();
});

it('过河后等对家还牌不计时', () => {
  const inbox = setup();
  room.act('h0', { type: 'guohe', seat: 0, cards: giveIds(0) });
  expect(room.state?.guohe?.asked).toEqual([]);
  expect(lastState(inbox).guoheLeftMs).toBeUndefined();
  vi.advanceTimersByTime(GRACE * 3);
  expect(room.state?.phase).toBe('guohe');
  room.act('h2', { type: 'guoheReturn', seat: 2, cards: plainIds(2, 5) });
  expect(room.state?.phase).toBe('playing');
  expect(room.state?.hands.map((h) => h.length)).toEqual([25, 25, 25, 25]);
});

it('机器人能过河也不过；真人过河给机器人对家，机器人自动还 5 张副牌', () => {
  setup([2]);
  vi.advanceTimersByTime(900);
  expect(room.state?.guohe?.asked).toEqual([0]);
  room.act('h0', { type: 'guohe', seat: 0, cards: giveIds(0) });
  vi.advanceTimersByTime(900);
  expect(room.state?.phase).toBe('playing');
  const ctx = ctxOf(room.state!);
  expect(room.state?.hands[0]!.filter((c) => isTrump(c, ctx))).toEqual([]);
  expect(room.state?.hands.map((h) => h.length)).toEqual([25, 25, 25, 25]);
});
