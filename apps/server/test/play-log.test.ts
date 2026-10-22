/** 出牌记录默认只能看自己出的牌，房主可以开放看所有人的。 */
import { afterEach, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { applyAction, createGame, createRng, declarationCandidates, defaultConfig, smartAction, waitingSeats, type Action, type GameState } from '@shengji/engine';
import type { ServerMessage } from '@shengji/protocol';
import { Room } from '../src/room.ts';

const opts = { dealIntervalMs: 5, declareGraceMs: 30_000, botDelayMs: 900, searchBudgetMs: 5 };

type StateMsg = Extract<ServerMessage, { t: 'state' }>;
type RoomMsg = Extract<ServerMessage, { t: 'room' }>;

function fakeSocket(inbox: ServerMessage[]): WebSocket {
  return { OPEN: 1, readyState: 1, send: (d: string) => inbox.push(JSON.parse(d) as ServerMessage) } as unknown as WebSocket;
}

function last<T extends ServerMessage['t']>(inbox: readonly ServerMessage[], t: T): Extract<ServerMessage, { t: T }> {
  const m = [...inbox].reverse().find((x) => x.t === t);
  if (!m) throw new Error(`没收到 ${t}`);
  return m as Extract<ServerMessage, { t: T }>;
}

function step(s: GameState, a: Action): GameState {
  const r = applyAction(s, a);
  if (!r.ok) throw new Error(r.error.message);
  return r.state;
}

/** 四人局打完第一墩的局面 */
function afterOneTrick(): GameState {
  const rng = createRng('play-log');
  let s = createGame(defaultConfig(4), 'play-log');
  while (s.tricks.length < 1) {
    if (s.phase === 'dealing') { s = step(s, { type: 'dealCard' }); continue; }
    if (s.phase === 'declaring') {
      const opt = declarationCandidates(s.hands[0] ?? [], s, 0)[0];
      s = step(s, s.declaration === null && opt ? { type: 'declare', seat: 0, cards: opt.map((c) => c.id) } : { type: 'closeDeclaring' });
      continue;
    }
    s = step(s, smartAction(s, waitingSeats(s)[0]!, rng)!);
  }
  return s;
}

let room: Room;
afterEach(() => { room.dispose(); });

function setup(): ServerMessage[] {
  room = new Room('TEST', 4, 'h0', opts);
  const inbox: ServerMessage[] = [];
  for (let i = 0; i < 4; i++) {
    room.join(`h${i}`, `玩家${i}`, i === 1 ? fakeSocket(inbox) : fakeSocket([]));
    room.sit(`h${i}`, i);
  }
  room.state = afterOneTrick();
  room.sync('h1');
  return inbox;
}

it('默认锁住：出牌记录里每墩只有自己出的牌，「上一轮」照常完整', () => {
  const inbox = setup();
  expect(last(inbox, 'room').room?.playLogOpen).toBe(false);
  const view = last(inbox, 'state').view;
  expect(view.tricks[0]!.plays.map((p) => p.seat)).toEqual([1]);
  expect(view.lastTrick?.plays.length).toBe(4);
});

it('只有房主能开放；开放后大家马上收到完整的出牌记录', () => {
  const inbox = setup();
  room.setPlayLog('h1', true);
  expect(last(inbox, 'error').code).toBe('NOT_HOST');
  expect(room.playLogOpen).toBe(false);
  room.setPlayLog('h0', true);
  expect((last(inbox, 'room') as RoomMsg).room?.playLogOpen).toBe(true);
  expect((last(inbox, 'state') as StateMsg).view.tricks[0]!.plays.length).toBe(4);
});

it('设置随存档保存', () => {
  setup();
  room.setPlayLog('h0', true);
  const restored = Room.fromSnapshot(room.toSnapshot(), opts);
  expect(restored.playLogOpen).toBe(true);
  restored.dispose();
});
