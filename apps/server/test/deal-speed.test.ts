/** 抢庄时发牌慢一点（issue #14）：首局从头到尾，非首局重新抢庄到定了庄家为止。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createGame, defaultConfig, type GameState } from '@shengji/engine';
import { Room } from '../src/room.ts';

const opts = { dealIntervalMs: 150, grabDealIntervalMs: 200, declareGraceMs: 30_000, botDelayMs: 900, searchBudgetMs: 5 };
const online = { OPEN: 1, readyState: 1, send: () => {} } as unknown as WebSocket;

let room: Room;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { room.dispose(); vi.useRealTimers(); });

/** 四个真人坐满，摆上局面，返回已发出的牌数 */
function start(state: GameState): () => number {
  room = new Room('TEST', 4, 'h0', opts);
  for (let i = 0; i < 4; i++) { room.join(`h${i}`, `玩家${i}`, online); room.sit(`h${i}`, i); }
  room.state = state;
  room.resume();
  return () => room.state!.hands.reduce((n, h) => n + h.length, 0);
}

it('首局抢庄：每张 200 毫秒', () => {
  const dealt = start(createGame(defaultConfig(4), 'speed-1'));
  vi.advanceTimersByTime(199);
  expect(dealt()).toBe(0);
  vi.advanceTimersByTime(1);
  expect(dealt()).toBe(1);
  vi.advanceTimersByTime(200 * 9);
  expect(dealt()).toBe(10);
});

it('非首局庄家已定：照常每张 150 毫秒', () => {
  const g = createGame(defaultConfig(4), 'speed-2');
  const dealt = start({ ...g, round: 2, dealer: 0 });
  vi.advanceTimersByTime(150 * 10);
  expect(dealt()).toBe(10);
});

it('非首局重新抢庄（还没定庄家）：每张 200 毫秒', () => {
  const g = createGame(defaultConfig(4), 'speed-3');
  const dealt = start({ ...g, round: 2, dealer: null });
  vi.advanceTimersByTime(150 * 10);
  expect(dealt()).toBe(7);
  // 有人亮主定了庄家，之后恢复正常速度
  room.state = { ...room.state!, dealer: 1 };
  const before = dealt();
  vi.advanceTimersByTime(200);
  vi.advanceTimersByTime(150 * 4);
  expect(dealt() - before).toBe(5);
});
