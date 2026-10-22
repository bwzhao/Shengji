/** 造反：机器人坐庄时等 10 秒再埋底，真人都点了「不造反」就不等（issue #13）。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { applyAction, cardPoints, createGame, declarationCandidates, defaultConfig, sumPoints, type Action, type GameState, type Seat } from '@shengji/engine';
import type { ServerMessage } from '@shengji/protocol';
import { Room } from '../src/room.ts';

const WAIT = 10_000;
const opts = { dealIntervalMs: 5, declareGraceMs: 30_000, zaofanWaitMs: WAIT, botDelayMs: 900, searchBudgetMs: 5 };

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

/** 首局 dealer 号位亮主坐庄，拿起底牌准备埋底 */
function bottomState(dealer: Seat): GameState {
  for (let k = 0; ; k++) {
    let s = createGame(defaultConfig(4), `zaofan-wait-${k}`);
    while (s.phase === 'dealing') s = step(s, { type: 'dealCard' });
    const opt = declarationCandidates(s.hands[dealer] ?? [], s, dealer)[0];
    if (!opt) continue;
    s = step(s, { type: 'declare', seat: dealer, cards: opt.map((c) => c.id) });
    return step(s, { type: 'closeDeclaring' });
  }
}

/** 把 seat 手里的分换给 donor，换到不多于 15 分 */
function lowPoints(s: GameState, seat: Seat, donor: Seat): GameState {
  const hands = s.hands.map((h) => [...h]);
  while (sumPoints(hands[seat]!) > 15) {
    const i = hands[seat]!.findIndex((c) => cardPoints(c) > 0 && c.suit !== 'J' && c.rank !== s.level);
    const j = hands[donor]!.findIndex((c) => cardPoints(c) === 0 && c.suit !== 'J' && c.rank !== s.level);
    [hands[seat]![i], hands[donor]![j]] = [hands[donor]![j]!, hands[seat]![i]!];
  }
  return { ...s, hands };
}

let room: Room;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { room.dispose(); vi.useRealTimers(); });

/** 3 号位机器人坐庄，0、1、2 号位真人（offline 里的不在线） */
function setup(state: GameState, offline: Seat[] = []): ServerMessage[] {
  room = new Room('TEST', 4, 'h0', opts);
  const inbox: ServerMessage[] = [];
  for (let i = 0; i < 3; i++) {
    room.join(`h${i}`, `玩家${i}`, offline.includes(i) ? null : i === 0 ? fakeSocket(inbox) : fakeSocket([]));
    room.sit(`h${i}`, i);
  }
  room.addBot('h0', 3);
  room.setBots('h0', 'normal');
  room.state = state;
  room.resume();
  return inbox;
}

it('机器人坐庄：等 10 秒再埋底，牌桌显示倒计时', () => {
  const inbox = setup(bottomState(3));
  expect(lastState(inbox).zaofanLeftMs).toBe(WAIT);
  vi.advanceTimersByTime(WAIT - 1);
  expect(room.state?.phase).toBe('bottom');
  vi.advanceTimersByTime(1);
  expect(room.state?.phase).not.toBe('bottom');
  expect(lastState(inbox).zaofanLeftMs).toBeUndefined();
});

it('在线真人都点了「不造反」就不再等，机器人照常稍等一下就埋底；离线的人不用点', () => {
  const inbox = setup(bottomState(3), [2]);
  room.passZaofan('h0');
  expect(lastState(inbox).zaofanPassed).toEqual([0]);
  vi.advanceTimersByTime(900);
  expect(room.state?.phase).toBe('bottom');
  room.passZaofan('h1');
  vi.advanceTimersByTime(900);
  expect(room.state?.phase).not.toBe('bottom');
});

it('等的时候真人可以造反：重新发牌抢庄，从他开始发', () => {
  setup(lowPoints(bottomState(3), 1, 3));
  vi.advanceTimersByTime(3000);
  room.act('h1', { type: 'zaofan', seat: 1 });
  expect(room.state?.phase).toBe('dealing');
  expect(room.state?.dealer).toBeNull();
  expect(room.state?.dealTurn).toBe(1);
  // 原来给机器人埋底排的定时器到点也不会出错
  vi.advanceTimersByTime(WAIT);
  expect(['dealing', 'declaring']).toContain(room.state?.phase);
});

it('真人坐庄不用等，也没有倒计时', () => {
  const inbox = setup(bottomState(0));
  expect(lastState(inbox).zaofanLeftMs).toBeUndefined();
});
