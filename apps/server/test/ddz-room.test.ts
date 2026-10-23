/** 斗地主房间：机器人代打、自动「要不起」、只看得到自己的手牌、存档恢复。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { applyDdzAction, createDdzGame, ddzFollowOptions, type DdzState } from '@shengji/engine';
import type { ServerMessage } from '@shengji/protocol';
import { DdzRoom } from '../src/ddzRoom.ts';

const opts = { dealIntervalMs: 5, declareGraceMs: 30_000, botDelayMs: 500, ddzAutoPassMs: 800, searchBudgetMs: 5 };
type DdzMsg = Extract<ServerMessage, { t: 'ddzState' }>;

function fakeSocket(inbox: ServerMessage[]): WebSocket {
  return { OPEN: 1, readyState: 1, send: (d: string) => inbox.push(JSON.parse(d) as ServerMessage) } as unknown as WebSocket;
}
const lastState = (inbox: readonly ServerMessage[]) => [...inbox].reverse().find((m): m is DdzMsg => m.t === 'ddzState')!;

let room: DdzRoom;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { room.dispose(); vi.useRealTimers(); });

/** 0 号位真人，1、2 号位机器人 */
function setup(): ServerMessage[] {
  room = new DdzRoom('TEST', 'h0', opts);
  const inbox: ServerMessage[] = [];
  room.join('h0', '玩家', fakeSocket(inbox));
  room.sit('h0', 0);
  room.addBot('h0', 1);
  room.addBot('h0', 2);
  return inbox;
}

it('开局后只看得到自己的手牌和各人张数；机器人轮到就叫分出牌', () => {
  const inbox = setup();
  room.start('h0');
  const st = lastState(inbox);
  expect(st.view.hand.length).toBe(17);
  expect(st.view.handCounts).toEqual([17, 17, 17]);
  expect(st.view.bottom).toBeNull();
  expect(room.info('h0')).toMatchObject({ game: 'doudizhu', players: 3 });
  // 轮到机器人时它会自己叫，轮到真人就停下
  vi.advanceTimersByTime(500 * 3);
  const s = room.state!;
  expect(s.phase === 'bidding' ? s.turn : 0).toBe(0);
});

it('真人管不住上家时自动「要不起」', () => {
  const inbox = setup();
  room.start('h0');
  // 摆一个出牌局面：地主 2 号位刚出了王炸，轮到 0 号位
  const base = room.state!;
  const jokers = [...base.hands.flat(), ...base.bottom].filter((c) => c.suit === 'J');
  const noJokers = (seat: number) => base.hands[seat]!.filter((c) => c.suit !== 'J');
  let s: DdzState = { ...base, phase: 'playing', landlord: 2, bid: 1, turn: 2, hands: [noJokers(0), noJokers(1), [...noJokers(2), ...jokers]] };
  const r = applyDdzAction(s, { type: 'play', seat: 2, cards: jokers.map((c) => c.id) });
  if (!r.ok) throw new Error(r.error.message);
  s = r.state;
  expect(ddzFollowOptions(s.hands[0]!, s.lastPlay!.combo)).toEqual([]);
  room.state = s;
  room.resume();
  expect(room.state.turn).toBe(0);
  vi.advanceTimersByTime(799);
  expect(room.state.turn).toBe(0);
  vi.advanceTimersByTime(1);
  expect(room.state.turn).toBe(1);
  expect(lastState(inbox).events).toContainEqual({ type: 'passed', seat: 0 });
});

it('存档恢复后接着打，积分保留', () => {
  setup();
  room.start('h0');
  room.state = { ...createDdzGame('snap'), scores: [6, -3, -3] };
  const restored = DdzRoom.fromSnapshot(room.toSnapshot(), opts);
  expect(restored.state?.scores).toEqual([6, -3, -3]);
  expect(restored.seats.map((s) => s?.isBot)).toEqual([false, true, true]);
  restored.dispose();
});
