/** 四人抄底的思考时间：轮到真人给 30 秒，到时当作不抄；机器人直接不抄（issue #6）。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { applyAction, createGame, declarationCandidates, defaultConfig, type Action, type GameState } from '@shengji/engine';
import type { ServerMessage } from '@shengji/protocol';
import { Room } from '../src/room.ts';

const GRACE = 30_000;
const opts = { dealIntervalMs: 5, declareGraceMs: GRACE, chaodiGraceMs: GRACE, botDelayMs: 900, searchBudgetMs: 5 };

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

/** 首局 1 号位亮主坐庄、埋完底，轮到 2、3、0 号位依次决定抄不抄 */
function chaodiState(): GameState {
  for (let k = 0; ; k++) {
    let s = createGame({ ...defaultConfig(4), guohe: false }, `chaodi-timer-${k}`);
    while (s.phase === 'dealing') s = step(s, { type: 'dealCard' });
    const option = declarationCandidates(s.hands[1] ?? [], s, 1)[0];
    if (!option) continue;
    s = step(s, { type: 'declare', seat: 1, cards: option.map((c) => c.id) });
    s = step(s, { type: 'closeDeclaring' });
    s = step(s, { type: 'exchangeBottom', seat: 1, cards: s.hands[1]!.slice(0, 8).map((c) => c.id) });
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
    room.join(`h${i}`, `玩家${i}`, i === 0 ? fakeSocket(inbox) : fakeSocket([]));
    room.sit(`h${i}`, i);
  }
  // 开局前把这些座位换成机器人
  for (const b of bots) { room.leave(`h${b}`); room.addBot('h0', b); }
  room.state = chaodiState();
  room.resume();
  return inbox;
}

it('轮到真人给 30 秒，到时当不抄、轮到下一家重新计时', () => {
  const inbox = setup();
  expect(room.state?.phase).toBe('chaodi');
  expect(room.state?.chaodi?.queue).toEqual([2, 3, 0]);
  expect(lastState(inbox).chaodiLeftMs).toBe(GRACE);

  vi.advanceTimersByTime(GRACE - 1);
  expect(room.state?.chaodi?.queue).toEqual([2, 3, 0]);
  vi.advanceTimersByTime(1);
  expect(room.state?.chaodi?.queue).toEqual([3, 0]);
  expect(lastState(inbox).chaodiLeftMs).toBe(GRACE);

  // 3 号位自己点「不抄」，0 号位重新计时
  vi.advanceTimersByTime(10_000);
  room.act('h3', { type: 'passChaodi', seat: 3 });
  expect(room.state?.chaodi?.queue).toEqual([0]);
  expect(lastState(inbox).chaodiLeftMs).toBe(GRACE);

  vi.advanceTimersByTime(GRACE);
  expect(room.state?.phase).toBe('playing');
  expect(lastState(inbox).chaodiLeftMs).toBeUndefined();
});

it('机器人不计时，稍等一下就不抄', () => {
  const inbox = setup([2, 3]);
  expect(room.state?.chaodi?.queue).toEqual([2, 3, 0]);
  expect(lastState(inbox).chaodiLeftMs).toBeUndefined();
  vi.advanceTimersByTime(900 * 2);
  expect(room.state?.chaodi?.queue).toEqual([0]);
  expect(lastState(inbox).chaodiLeftMs).toBe(GRACE);
});
