/** 四人升级的可选规则：开房时选抄底、过河，开局前房主能改，开局后锁住，牌局按开局时的规则走，随存档保存。 */
import { afterEach, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { applyAction, createGame, declarationCandidates, type Action, type GameState } from '@shengji/engine';
import type { ServerMessage } from '@shengji/protocol';
import { Registry } from '../src/registry.ts';
import { Room } from '../src/room.ts';

const opts = { dealIntervalMs: 5, declareGraceMs: 30_000, botDelayMs: 900, searchBudgetMs: 5 };

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

const rooms: Room[] = [];
afterEach(() => { for (const r of rooms.splice(0)) r.dispose(); });

/** 房主 h0 和另一个真人 h1 进房间坐下 */
function setup(rules?: { chaodi?: boolean; guohe?: boolean }): { room: Room; host: ServerMessage[]; guest: ServerMessage[] } {
  const room = new Room('RULE', 4, 'h0', opts, rules);
  rooms.push(room);
  const host: ServerMessage[] = [];
  const guest: ServerMessage[] = [];
  room.join('h0', '房主', fakeSocket(host));
  room.sit('h0', 0);
  room.join('h1', '客人', fakeSocket(guest));
  room.sit('h1', 1);
  return { room, host, guest };
}

it('不选就都打开，和以前一样；五、六人局没有这两条规则', () => {
  const { room, host } = setup();
  expect(room.rules).toEqual({ chaodi: true, guohe: true });
  expect(last(host, 'room').room?.rules).toEqual({ chaodi: true, guohe: true });
  expect(room.config.chaodi).toBe(true);
  expect(room.config.guohe).toBe(true);
  for (const players of [5, 6] as const) {
    const r = new Room('FIVE', players, 'h0', opts, { chaodi: false });
    rooms.push(r);
    expect(r.rules).toBeNull();
    expect(r.config.chaodi).toBeUndefined();
    expect(r.summary('h0').rules).toBeNull();
  }
});

it('开房时选的规则：房间信息和首页列表里都看得到', () => {
  const { room, guest } = setup({ chaodi: false });
  expect(room.rules).toEqual({ chaodi: false, guohe: true });
  expect(last(guest, 'room').room?.rules).toEqual({ chaodi: false, guohe: true });
  expect(room.summary('h1').rules).toEqual({ chaodi: false, guohe: true });

  const registry = new Registry(opts);
  const r = registry.createRoom('x', 4, { guohe: false }) as Room;
  rooms.push(r);
  expect(r.rules).toEqual({ chaodi: true, guohe: false });
});

it('开局前只有房主能改，大家马上看到', () => {
  const { room, host, guest } = setup();
  room.setRules('h1', { chaodi: false });
  expect(last(guest, 'error').code).toBe('NOT_HOST');
  expect(room.rules).toEqual({ chaodi: true, guohe: true });
  room.setRules('h0', { chaodi: false });
  room.setRules('h0', { guohe: false });
  expect(room.rules).toEqual({ chaodi: false, guohe: false });
  expect((last(guest, 'room') as RoomMsg).room?.rules).toEqual({ chaodi: false, guohe: false });
  expect((last(host, 'room') as RoomMsg).room?.rules).toEqual({ chaodi: false, guohe: false });
  room.setRules('h0', { chaodi: true });
  expect(room.rules).toEqual({ chaodi: true, guohe: false });
});

it('五、六人局不能改', () => {
  const room = new Room('FIVE', 5, 'h0', opts);
  rooms.push(room);
  const inbox: ServerMessage[] = [];
  room.join('h0', '房主', fakeSocket(inbox));
  room.setRules('h0', { chaodi: true });
  expect(last(inbox, 'error').code).toBe('NO_RULES');
  expect(room.rules).toBeNull();
});

it('开局后锁住，牌局按开局时的规则走：都关掉时埋完底直接开打', () => {
  const { room, host } = setup({ chaodi: false, guohe: false });
  room.addBot('h0', 2);
  room.addBot('h0', 3);
  room.start('h0');
  expect(room.state?.config.chaodi).toBe(false);
  expect(room.state?.config.guohe).toBe(false);
  room.setRules('h0', { chaodi: true });
  expect(last(host, 'error').code).toBe('STARTED');
  expect(room.rules).toEqual({ chaodi: false, guohe: false });

  // 用这一局的规则自己走到埋完底：不问抄底，也不问过河
  const config = room.state!.config;
  for (let k = 0; ; k++) {
    let s = createGame(config, `rules-${k}`);
    while (s.phase === 'dealing') s = step(s, { type: 'dealCard' });
    const option = declarationCandidates(s.hands[1] ?? [], s, 1)[0];
    if (!option) continue;
    s = step(s, { type: 'declare', seat: 1, cards: option.map((c) => c.id) });
    s = step(s, { type: 'closeDeclaring' });
    if (s.phase !== 'bottom') continue;
    const dealer = s.dealer!;
    s = step(s, { type: 'exchangeBottom', seat: dealer, cards: s.hands[dealer]!.slice(0, 8).map((c) => c.id) });
    expect(s.phase).toBe('playing');
    break;
  }
});

it('规则随存档保存；旧存档没有规则按都打开', () => {
  const { room } = setup({ guohe: false });
  const snap = room.toSnapshot();
  expect(snap.rules).toEqual({ chaodi: true, guohe: false });
  const restored = Room.fromSnapshot(snap, opts);
  rooms.push(restored);
  expect(restored.rules).toEqual({ chaodi: true, guohe: false });
  const { rules: _drop, ...old } = snap;
  const legacy = Room.fromSnapshot(old, opts);
  rooms.push(legacy);
  expect(legacy.rules).toEqual({ chaodi: true, guohe: true });
});
