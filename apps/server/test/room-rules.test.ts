/** 升级的可选规则：开房时选抄底、过河（四人局）和造反分数线，开局前房主能改，开局后锁住，牌局按开局时的规则走，随存档保存。 */
import { afterEach, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { applyAction, createGame, declarationCandidates, zaofanError, type Action, type GameState } from '@shengji/engine';
import { zaofanRuleError, type RoomRules, type ServerMessage } from '@shengji/protocol';
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
function setup(rules?: Partial<RoomRules>): { room: Room; host: ServerMessage[]; guest: ServerMessage[] } {
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

/** 各人数默认的造反分数线 */
const Z4 = { low: 15, high: 85, dealerHigh: 95 };
const Z5 = { low: 15, high: 105, dealerHigh: 120 };
const Z6 = { low: 15, high: 90, dealerHigh: 100 };

it('不选就按默认，和以前一样：四人抄底、过河都打开；五、六人局没有抄底过河；造反用各自的默认分数线', () => {
  const { room, host } = setup();
  expect(room.rules).toEqual({ chaodi: true, guohe: true, zaofan: Z4 });
  expect(last(host, 'room').room?.rules).toEqual({ chaodi: true, guohe: true, zaofan: Z4 });
  expect(room.config).toMatchObject({ chaodi: true, guohe: true, zaofan: Z4 });
  for (const [players, z] of [[5, Z5], [6, Z6]] as const) {
    const r = new Room('FIVE', players, 'h0', opts, { chaodi: true });
    rooms.push(r);
    expect(r.rules).toEqual({ chaodi: false, guohe: false, zaofan: z });
    expect(r.config.chaodi).toBeUndefined();
    expect(r.config.zaofan).toEqual(z);
    expect(r.summary('h0').rules).toEqual({ chaodi: false, guohe: false, zaofan: z });
  }
});

it('开房时选的规则：房间信息和首页列表里都看得到', () => {
  const { room, guest } = setup({ chaodi: false, zaofan: { low: 10, high: 80, dealerHigh: 90 } });
  const want = { chaodi: false, guohe: true, zaofan: { low: 10, high: 80, dealerHigh: 90 } };
  expect(room.rules).toEqual(want);
  expect(last(guest, 'room').room?.rules).toEqual(want);
  expect(room.summary('h1').rules).toEqual(want);
  expect(room.config.zaofan).toEqual(want.zaofan);

  const registry = new Registry(opts);
  const r = registry.createRoom('x', 4, { guohe: false }) as Room;
  rooms.push(r);
  expect(r.rules).toEqual({ chaodi: true, guohe: false, zaofan: Z4 });
  const six = registry.createRoom('y', 6, { zaofan: null }) as Room;
  rooms.push(six);
  expect(six.rules.zaofan).toBeNull();
});

it('开局前只有房主能改，大家马上看到', () => {
  const { room, host, guest } = setup();
  room.setRules('h1', { chaodi: false });
  expect(last(guest, 'error').code).toBe('NOT_HOST');
  expect(room.rules).toEqual({ chaodi: true, guohe: true, zaofan: Z4 });
  room.setRules('h0', { chaodi: false });
  room.setRules('h0', { guohe: false });
  room.setRules('h0', { zaofan: { low: 20, high: 80, dealerHigh: 90 } });
  const want = { chaodi: false, guohe: false, zaofan: { low: 20, high: 80, dealerHigh: 90 } };
  expect(room.rules).toEqual(want);
  expect((last(guest, 'room') as RoomMsg).room?.rules).toEqual(want);
  expect((last(host, 'room') as RoomMsg).room?.rules).toEqual(want);
  room.setRules('h0', { chaodi: true, zaofan: null });
  expect(room.rules).toEqual({ chaodi: true, guohe: false, zaofan: null });
  expect(room.config.zaofan).toBeUndefined();
});

it('五、六人局能改造反分数线，不能打开抄底过河', () => {
  const room = new Room('FIVE', 5, 'h0', opts);
  rooms.push(room);
  const inbox: ServerMessage[] = [];
  room.join('h0', '房主', fakeSocket(inbox));
  room.setRules('h0', { chaodi: true });
  expect(last(inbox, 'error')).toMatchObject({ code: 'BAD_RULES', message: '只有四人局能选抄底和过河' });
  room.setRules('h0', { zaofan: { low: 20, high: 150, dealerHigh: 180 } });
  expect(room.rules).toEqual({ chaodi: false, guohe: false, zaofan: { low: 20, high: 150, dealerHigh: 180 } });
});

it('不合理的造反分数线不收，规则不变', () => {
  const { room, host } = setup();
  for (const zaofan of [
    { low: 50, high: 50, dealerHigh: 60 },
    { low: 15, high: 85, dealerHigh: 80 },
    { low: 15, high: 85, dealerHigh: 205 },
  ]) {
    room.setRules('h0', { zaofan });
    expect(last(host, 'error').code).toBe('BAD_RULES');
    expect(room.rules.zaofan).toEqual(Z4);
  }
  expect(zaofanRuleError({ low: 15, high: 85, dealerHigh: 205 }, 4)).toBe('造反分数不能超过总分 200');
  // 五、六人三副牌，总分 300
  expect(zaofanRuleError({ low: 15, high: 85, dealerHigh: 205 }, 6)).toBeNull();
  expect(Room.rulesError(4, { zaofan: { low: 50, high: 40, dealerHigh: 60 } })).toBe('造反的上限要比下限大');
  expect(Room.rulesError(4, { chaodi: false, zaofan: null })).toBeNull();
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
  expect(room.rules).toEqual({ chaodi: false, guohe: false, zaofan: Z4 });

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

it('牌局按开局时的造反分数线判断；不能造反时谁都不能造反', () => {
  // 分数线放到最宽：手里有分就能造反
  const { room } = setup({ zaofan: { low: 0, high: 5, dealerHigh: 5 } });
  room.addBot('h0', 2);
  room.addBot('h0', 3);
  room.start('h0');
  expect(room.state?.config.zaofan).toEqual({ low: 0, high: 5, dealerHigh: 5 });
  const bury = (cfg: GameState['config']): GameState => {
    for (let k = 0; ; k++) {
      let s = createGame(cfg, `zaofan-rule-${k}`);
      while (s.phase === 'dealing') s = step(s, { type: 'dealCard' });
      const option = declarationCandidates(s.hands[1] ?? [], s, 1)[0];
      if (!option) continue;
      s = step(s, { type: 'declare', seat: 1, cards: option.map((c) => c.id) });
      s = step(s, { type: 'closeDeclaring' });
      if (s.phase === 'bottom') return s;
    }
  };
  const wide = bury(room.state!.config);
  expect([0, 2, 3].every((seat) => zaofanError(wide, seat, wide.hands[seat]!) === null)).toBe(true);

  const off = new Room('NOZF', 4, 'h0', opts, { zaofan: null });
  rooms.push(off);
  const none = bury(off.config);
  expect(zaofanError(none, 0, none.hands[0]!)?.message).toBe('这个模式不能造反');
});

it('规则随存档保存；旧存档缺的规则按默认', () => {
  const { room } = setup({ guohe: false, zaofan: { low: 10, high: 90, dealerHigh: 100 } });
  const snap = room.toSnapshot();
  expect(snap.rules).toEqual({ chaodi: true, guohe: false, zaofan: { low: 10, high: 90, dealerHigh: 100 } });
  const restored = Room.fromSnapshot(snap, opts);
  rooms.push(restored);
  expect(restored.rules).toEqual(snap.rules);
  // 上一版只存了抄底、过河
  const prev = Room.fromSnapshot({ ...snap, rules: { chaodi: false, guohe: true } }, opts);
  rooms.push(prev);
  expect(prev.rules).toEqual({ chaodi: false, guohe: true, zaofan: Z4 });
  // 更早的存档没有规则
  const { rules: _drop, ...old } = snap;
  const legacy = Room.fromSnapshot(old, opts);
  rooms.push(legacy);
  expect(legacy.rules).toEqual({ chaodi: true, guohe: true, zaofan: Z4 });
  const legacySix = Room.fromSnapshot({ ...old, players: 6, seats: Array(6).fill(null) }, opts);
  rooms.push(legacySix);
  expect(legacySix.rules).toEqual({ chaodi: false, guohe: false, zaofan: Z6 });
});
