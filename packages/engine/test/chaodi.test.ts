/** 四人抄底（GitHub issue #6）。 */
import { describe, expect, it } from 'vitest';
import { cardId, type CardSuit } from '../src/cards.ts';
import { defaultConfig } from '../src/config.ts';
import { applyAction, createGame } from '../src/reducer.ts';
import { simulateGame } from '../src/sim/run.ts';
import type { GameState } from '../src/state.ts';
import { viewFor } from '../src/view.ts';

function must(r: ReturnType<typeof applyAction>): GameState {
  if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`);
  return r.state;
}

function dealAll(s: GameState): GameState {
  while (s.phase === 'dealing') s = must(applyAction(s, { type: 'dealCard' }));
  return s;
}

const L = 2; // 四人从 2 打起
/** 这里只看抄底，关掉过河，免得有人主少时停在过河阶段 */
const CFG = { ...defaultConfig(4), guohe: false };
/** 一对常主的两张牌 id：花色级牌，或 'BJ' / 'SJ' 一对大王、小王 */
const pair = (what: CardSuit | 'BJ' | 'SJ'): string[] =>
  what === 'BJ' ? [cardId('J', 16, 0), cardId('J', 16, 1)]
    : what === 'SJ' ? [cardId('J', 15, 0), cardId('J', 15, 1)]
      : [cardId(what, L, 0), cardId(what, L, 1)];

/** 把指定的牌换到 seat 手里（和他手里一张不相干的普通牌交换） */
function give(s: GameState, seat: number, ids: string[]): GameState {
  const hands = s.hands.map((h) => [...h]);
  const bottom = [...s.bottom];
  for (const id of ids) {
    if (hands[seat]!.some((c) => c.id === id)) continue;
    const k = hands[seat]!.findIndex((c) => c.suit !== 'J' && c.rank !== L);
    const out = hands[seat]![k]!;
    const holder = hands.findIndex((h) => h.some((c) => c.id === id));
    const from = holder >= 0 ? hands[holder]! : bottom;
    const i = from.findIndex((c) => c.id === id);
    hands[seat]![k] = from[i]!;
    from[i] = out;
  }
  return { ...s, hands, bottom };
}

/**
 * 第二局，庄家 0 号位，1 号位亮主（默认一张 ♣2）。2 号位有一对 ♥2，3 号位有一对 ♠2 和一对 ♦2，0 号位有一对大王
 * （1 号位亮的牌最后发给他，亮一对大王时 0 号位就没有了）。返回庄家刚拿起底牌、还没埋的局面。
 */
function setup(declared: string[] = [cardId('C', L, 0)]): GameState {
  let s = { ...dealAll(createGame(CFG, 'chaodi')), round: 2, dealer: 0 as number | null };
  s = give(s, 2, pair('H'));
  s = give(s, 3, [...pair('S'), ...pair('D')]);
  s = give(s, 0, pair('BJ'));
  s = give(s, 1, declared);
  s = must(applyAction(s, { type: 'declare', seat: 1, cards: declared }));
  s = must(applyAction(s, { type: 'closeDeclaring' }));
  expect(s.phase).toBe('bottom');
  return s;
}

/** 埋手里 8 张不相干的牌，不碰常主 */
function bury(s: GameState, seat: number): GameState {
  const cards = s.hands[seat]!.filter((c) => c.suit !== 'J' && c.rank !== s.level).slice(0, 8);
  return must(applyAction(s, { type: 'exchangeBottom', seat, cards: cards.map((c) => c.id) }));
}

describe('四人抄底（#6）', () => {
  it('庄家埋底后从下家起依次问，庄家和亮主的人不问；都不抄就开打，庄家先出', () => {
    let s = bury(setup(), 0);
    expect(s.phase).toBe('chaodi');
    expect(s.chaodi?.queue).toEqual([2, 3]);
    // 必须按顺序问
    expect(applyAction(s, { type: 'passChaodi', seat: 3 }).ok).toBe(false);
    s = must(applyAction(s, { type: 'passChaodi', seat: 2 }));
    expect(s.chaodi?.queue).toEqual([3]);
    s = must(applyAction(s, { type: 'passChaodi', seat: 3 }));
    expect(s.phase).toBe('playing');
    expect(s.trick?.leader).toBe(0);
    expect(s.chaodi).toBeNull();
  });

  it('抄底：拿起底牌重新埋、改主，庄家不变；之后再问一圈，庄家和亮主的人也能抄；只有最后埋底的人能看底', () => {
    let s = bury(setup(), 0);
    expect(viewFor(s, 0).bottom).toEqual(s.bottom);
    s = must(applyAction(s, { type: 'chaodi', seat: 2, cards: pair('H') }));
    expect(s.phase).toBe('bottom');
    expect(s.trumpSuit).toBe('H');
    expect(s.dealer).toBe(0);
    expect(s.hands[2]!.length).toBe(25 + 8);
    expect(s.declarationLog?.at(-1)).toMatchObject({ kind: 'chaodi', seat: 2, suit: 'H' });
    // 现在该 2 号位埋，庄家不能埋
    expect(applyAction(s, { type: 'exchangeBottom', seat: 0, cards: s.hands[0]!.slice(0, 8).map((c) => c.id) }).ok).toBe(false);
    s = bury(s, 2);
    expect(s.phase).toBe('chaodi');
    expect(s.chaodi?.queue).toEqual([3, 0, 1]);
    expect(viewFor(s, 2).bottom).toEqual(s.bottom);
    expect(viewFor(s, 0).bottom).toBeNull();
    expect(viewFor(s, 0).buryer).toBe(2);
  });

  it('后面抄底要比上一次大：大王 > 小王 > ♠ > ♥ > ♣ > ♦', () => {
    let s = bury(setup(), 0);
    s = must(applyAction(s, { type: 'chaodi', seat: 2, cards: pair('H') }));
    s = bury(s, 2);
    const weak = applyAction(s, { type: 'chaodi', seat: 3, cards: pair('D') });
    expect(!weak.ok && weak.error.code).toBe('DECLARATION_TOO_WEAK');
    s = must(applyAction(s, { type: 'chaodi', seat: 3, cards: pair('S') }));
    expect(s.trumpSuit).toBe('S');
  });

  it('第一次抄底任意一对常主都行，比亮主的花色小也行', () => {
    let s = bury(setup(), 0);
    s = must(applyAction(s, { type: 'passChaodi', seat: 2 }));
    // 当前主是 ♣，♦ 比 ♣ 小，第一次抄底照样可以
    s = must(applyAction(s, { type: 'chaodi', seat: 3, cards: pair('D') }));
    expect(s.trumpSuit).toBe('D');
  });

  it('亮主亮的是一对，第一次抄底也要比它大', () => {
    let s = bury(setup(pair('C')), 0);
    expect(s.chaodi?.queue).toEqual([2, 3]);
    s = must(applyAction(s, { type: 'passChaodi', seat: 2 }));
    const weak = applyAction(s, { type: 'chaodi', seat: 3, cards: pair('D') });
    expect(!weak.ok && weak.error.code).toBe('DECLARATION_TOO_WEAK');
    s = must(applyAction(s, { type: 'chaodi', seat: 3, cards: pair('S') }));
    expect(s.trumpSuit).toBe('S');
  });

  it('亮主亮的是一对大王就不问抄底', () => {
    const s = bury(setup(pair('BJ')), 0);
    expect(s.phase).toBe('playing');
  });

  it('抄底亮出一对大王就不再问，埋完直接开打，还是庄家先出', () => {
    let s = bury(setup(), 0);
    s = must(applyAction(s, { type: 'chaodi', seat: 2, cards: pair('H') }));
    s = bury(s, 2);
    s = must(applyAction(s, { type: 'passChaodi', seat: 3 }));
    s = must(applyAction(s, { type: 'chaodi', seat: 0, cards: pair('BJ') }));
    expect(s.trumpSuit).toBeNull();
    s = bury(s, 0);
    expect(s.phase).toBe('playing');
    expect(s.trick?.leader).toBe(0);
  });

  it('单张、两张不一样的、不是常主的对子都不能抄底', () => {
    const s = bury(setup(), 0);
    const hand = s.hands[2]!;
    expect(applyAction(s, { type: 'chaodi', seat: 2, cards: [pair('H')[0]!] }).ok).toBe(false);
    const plain = hand.find((c) => c.suit !== 'J' && c.rank !== L)!;
    expect(applyAction(s, { type: 'chaodi', seat: 2, cards: [pair('H')[0]!, plain.id] }).ok).toBe(false);
    const twin = hand.find((c) => c.suit !== 'J' && c.rank !== L && hand.some((d) => d !== c && d.suit === c.suit && d.rank === c.rank));
    if (twin) {
      const other = hand.find((d) => d !== twin && d.suit === twin.suit && d.rank === twin.rank)!;
      expect(applyAction(s, { type: 'chaodi', seat: 2, cards: [twin.id, other.id] }).ok).toBe(false);
    }
  });

  it('翻底定主的一局不抄底，庄家埋完直接开打', () => {
    for (let k = 0; ; k++) {
      let s = { ...dealAll(createGame(CFG, `chaodi-flip-${k}`)), round: 2, dealer: 0 as number | null };
      if (!s.bottom.some((c) => c.suit === 'J' || c.rank === s.level)) continue;
      s = must(applyAction(s, { type: 'closeDeclaring' }));
      s = bury(s, 0);
      expect(s.phase).toBe('playing');
      return;
    }
  });

  it('自对弈：随机机器人会抄底，牌局都能打完、牌和分都守恒', () => {
    let chaodis = 0;
    for (let g = 0; g < 6; g++) {
      simulateGame(defaultConfig(4), `chaodi-sim-${g}`, {
        maxRounds: 10,
        onEvent: (e) => { if (e.type === 'chaodi') chaodis++; },
      });
    }
    expect(chaodis).toBeGreaterThan(0);
  }, 120_000);
});
