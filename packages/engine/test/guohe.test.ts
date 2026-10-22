/** 四人过河（GitHub issue #7）。 */
import { describe, expect, it } from 'vitest';
import { cardId, type Card } from '../src/cards.ts';
import { defaultConfig } from '../src/config.ts';
import { applyAction, createGame, ctxOf, waitingSeats } from '../src/reducer.ts';
import { simulateGame } from '../src/sim/run.ts';
import type { GameState, Seat } from '../src/state.ts';
import { isTrump } from '../src/trump.ts';
import { viewFor } from '../src/view.ts';

function must(r: ReturnType<typeof applyAction>): GameState {
  if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`);
  return r.state;
}

const L = 2; // 四人从 2 打起
const ids = (cards: readonly Card[]) => cards.map((c) => c.id);
const trumpsOf = (s: GameState, seat: Seat) => s.hands[seat]!.filter((c) => isTrump(c, ctxOf(s)));
const plainOf = (s: GameState, seat: Seat) => s.hands[seat]!.filter((c) => !isTrump(c, ctxOf(s)));

/** 和 0 号位（庄家）换牌，让 seat 手里正好 n 张主 */
function setTrumps(s: GameState, seat: Seat, n: number): GameState {
  const hands = s.hands.map((h) => [...h]);
  const ctx = ctxOf(s);
  const count = () => hands[seat]!.filter((c) => isTrump(c, ctx)).length;
  while (count() !== n) {
    const giveTrump = count() > n;
    const i = hands[seat]!.findIndex((c) => isTrump(c, ctx) === giveTrump);
    const j = hands[0]!.findIndex((c) => isTrump(c, ctx) !== giveTrump);
    [hands[seat]![i], hands[0]![j]] = [hands[0]![j]!, hands[seat]![i]!];
  }
  return { ...s, hands };
}

/** 埋手里 8 张不相干的牌 */
function bury(s: GameState, seat: Seat): GameState {
  const cards = s.hands[seat]!.filter((c) => c.suit !== 'J' && c.rank !== s.level).slice(0, 8);
  return must(applyAction(s, { type: 'exchangeBottom', seat, cards: ids(cards) }));
}

/**
 * 第二局，庄家 0 号位，1 号位亮主（默认一张 ♣2），庄家埋完底，进入抄底阶段（问 2、3 号位）。
 * trumps 指定各座位进入过河前手里的主牌张数。
 */
function setup(trumps: Partial<Record<Seat, number>>, declared = [cardId('C', L, 0)]): GameState {
  let s = createGame(defaultConfig(4), 'guohe');
  while (s.phase === 'dealing') s = must(applyAction(s, { type: 'dealCard' }));
  s = { ...s, round: 2, dealer: 0 };
  // 把亮主的牌换到 1 号位手里
  const hands = s.hands.map((h) => [...h]);
  for (const id of declared) {
    if (hands[1]!.some((c) => c.id === id)) continue;
    const holder = hands.findIndex((h) => h.some((c) => c.id === id));
    const from = holder >= 0 ? hands[holder]! : null;
    const k = hands[1]!.findIndex((c) => c.suit !== 'J' && c.rank !== L);
    if (from) {
      const i = from.findIndex((c) => c.id === id);
      [hands[1]![k], from[i]] = [from[i]!, hands[1]![k]!];
    } else {
      const bottom = [...s.bottom];
      const i = bottom.findIndex((c) => c.id === id);
      [hands[1]![k], bottom[i]] = [bottom[i]!, hands[1]![k]!];
      s = { ...s, bottom };
    }
  }
  s = { ...s, hands };
  s = must(applyAction(s, { type: 'declare', seat: 1, cards: declared }));
  s = must(applyAction(s, { type: 'closeDeclaring' }));
  s = bury(s, 0);
  expect(s.phase).toBe('chaodi');
  for (const [seat, n] of Object.entries(trumps)) s = setTrumps(s, Number(seat), n as number);
  return s;
}

/** 抄底这一圈都不抄 */
function passAll(s: GameState): GameState {
  while (s.phase === 'chaodi') s = must(applyAction(s, { type: 'passChaodi', seat: s.chaodi!.queue[0]! }));
  return s;
}

describe('四人过河（#7）', () => {
  it('抄底问完后同时问主不多于 5 张的人，庄家不问；都不过就开打', () => {
    let s = passAll(setup({ 1: 5, 2: 9, 3: 3 }));
    expect(s.phase).toBe('guohe');
    expect(s.guohe?.asked).toEqual([1, 3]);
    expect(waitingSeats(s)).toEqual([1, 3]);
    // 同时问，不分先后
    s = must(applyAction(s, { type: 'passGuohe', seat: 3 }));
    s = must(applyAction(s, { type: 'passGuohe', seat: 1 }));
    expect(s.phase).toBe('playing');
    expect(s.trick?.leader).toBe(0);
  });

  it('过河：5 张含全部主牌给对家，对家还 5 张副牌；一队只过一次', () => {
    let s = passAll(setup({ 1: 3, 2: 9, 3: 4 }));
    const given = [...trumpsOf(s, 1), ...plainOf(s, 1).slice(0, 2)];
    s = must(applyAction(s, { type: 'guohe', seat: 1, cards: ids(given) }));
    expect(s.phase).toBe('guohe');
    // 3 号位是接牌的对家，不再问他过不过河
    expect(s.guohe?.asked).toEqual([]);
    expect(waitingSeats(s)).toEqual([3]);
    expect(s.hands[1]!.length).toBe(20);
    expect(s.hands[3]!.length).toBe(30);
    expect(applyAction(s, { type: 'guohe', seat: 3, cards: ids(trumpsOf(s, 3).slice(0, 5)) }).ok).toBe(false);
    const back = plainOf(s, 3).slice(0, 5);
    s = must(applyAction(s, { type: 'guoheReturn', seat: 3, cards: ids(back) }));
    expect(s.phase).toBe('playing');
    expect(s.hands[1]!.length).toBe(25);
    expect(s.hands[3]!.length).toBe(25);
    expect(trumpsOf(s, 1)).toEqual([]);
    expect(s.hands[3]!.some((c) => c.id === given[0]!.id)).toBe(true);
    // 过河记录留到本局结束，牌只有双方看得到
    expect(viewFor(s, 0).guohe?.crossings).toEqual([{ from: 1, to: 3, given: null, returned: null, done: true }]);
    expect(viewFor(s, 1).guohe?.crossings[0]?.given).toEqual(given);
    expect(viewFor(s, 3).guohe?.crossings[0]?.returned).toEqual(back);
  });

  it('给的牌必须是 5 张、含全部主牌；还的牌只能是副牌；不在名单上的人不能过河', () => {
    let s = passAll(setup({ 1: 3, 2: 9, 3: 9 }));
    expect(s.guohe?.asked).toEqual([1]);
    const trumps = trumpsOf(s, 1);
    const plain = plainOf(s, 1);
    const missing = applyAction(s, { type: 'guohe', seat: 1, cards: ids([...trumps.slice(1), ...plain.slice(0, 3)]) });
    expect(!missing.ok && missing.error.code).toBe('INVALID_GUOHE');
    const four = applyAction(s, { type: 'guohe', seat: 1, cards: ids([...trumps, ...plain.slice(0, 1)]) });
    expect(!four.ok && four.error.code).toBe('WRONG_CARD_COUNT');
    expect(applyAction(s, { type: 'guohe', seat: 3, cards: ids(plainOf(s, 3).slice(0, 5)) }).ok).toBe(false);
    expect(applyAction(s, { type: 'passGuohe', seat: 2 }).ok).toBe(false);
    expect(applyAction(s, { type: 'guoheReturn', seat: 3, cards: ids(plainOf(s, 3).slice(0, 5)) }).ok).toBe(false);
    s = must(applyAction(s, { type: 'guohe', seat: 1, cards: ids([...trumps, ...plain.slice(0, 2)]) }));
    const withTrump = applyAction(s, { type: 'guoheReturn', seat: 3, cards: ids([...trumpsOf(s, 3).slice(0, 1), ...plainOf(s, 3).slice(0, 4)]) });
    expect(!withTrump.ok && withTrump.error.code).toBe('INVALID_GUOHE');
  });

  it('两队可以各过一次；庄家不能过河，但可以接对家过来的牌', () => {
    let s = passAll(setup({ 1: 2, 2: 5, 3: 9 }));
    expect(s.guohe?.asked).toEqual([1, 2]);
    s = must(applyAction(s, { type: 'guohe', seat: 2, cards: ids([...trumpsOf(s, 2), ...plainOf(s, 2)].slice(0, 5)) }));
    s = must(applyAction(s, { type: 'guohe', seat: 1, cards: ids([...trumpsOf(s, 1), ...plainOf(s, 1)].slice(0, 5)) }));
    expect(waitingSeats(s)).toEqual([0, 3]);
    s = must(applyAction(s, { type: 'guoheReturn', seat: 3, cards: ids(plainOf(s, 3).slice(0, 5)) }));
    expect(s.phase).toBe('guohe');
    s = must(applyAction(s, { type: 'guoheReturn', seat: 0, cards: ids(plainOf(s, 0).slice(0, 5)) }));
    expect(s.phase).toBe('playing');
    expect(s.hands.map((h) => h.length)).toEqual([25, 25, 25, 25]);
  });

  it('抄过底的人不能过河', () => {
    let s = setup({});
    const twin = [cardId('H', L, 0), cardId('H', L, 1)];
    // 把一对 ♥2 给 2 号位让他抄底
    const hands = s.hands.map((h) => [...h]);
    for (const id of twin) {
      if (hands[2]!.some((c) => c.id === id)) continue;
      const holder = hands.findIndex((h) => h.some((c) => c.id === id));
      const k = hands[2]!.findIndex((c) => c.suit !== 'J' && c.rank !== L);
      const i = hands[holder]!.findIndex((c) => c.id === id);
      [hands[2]![k], hands[holder]![i]] = [hands[holder]![i]!, hands[2]![k]!];
    }
    s = { ...s, hands };
    s = must(applyAction(s, { type: 'chaodi', seat: 2, cards: twin }));
    s = bury(s, 2);
    for (const seat of [1, 2, 3]) s = setTrumps(s, seat, 4);
    s = passAll(s);
    expect(s.phase).toBe('guohe');
    expect(s.guohe?.asked).toEqual([1, 3]);
  });

  it('打无主不过河', () => {
    const s = passAll(setup({ 1: 3, 2: 3, 3: 3 }, [cardId('J', 15, 0), cardId('J', 15, 1)]));
    expect(s.trumpSuit).toBeNull();
    expect(s.phase).toBe('playing');
  });

  it('关掉过河的旧配置照常开打', () => {
    let s = setup({ 1: 3 });
    s = { ...s, config: { ...s.config, guohe: undefined } };
    expect(passAll(s).phase).toBe('playing');
  });

  it('自对弈：随机机器人会过河，牌局都能打完、牌和分都守恒', () => {
    let crossings = 0;
    for (let g = 0; g < 6; g++) {
      simulateGame(defaultConfig(4), `guohe-sim-${g}`, {
        maxRounds: 10,
        onEvent: (e) => { if (e.type === 'guoheReturned') crossings++; },
      });
    }
    expect(crossings).toBeGreaterThan(0);
  }, 120_000);
});
