/** 三人斗地主：牌型、叫分、出牌、计分、机器人自对弈。 */
import { describe, expect, it } from 'vitest';
import { BIG_JOKER, SMALL_JOKER, cardId, type Card, type CardSuit } from '../src/cards.ts';
import {
  applyDdzAction, classifyDdz, createDdzGame, ddzBeats, ddzBotAction, ddzComboFor, ddzFollowOptions, ddzViewFor,
  planDdzHand, type DdzState,
} from '../src/ddz/index.ts';

/** 牌的简写：'3' '10' 'J' 'A' '2' 'sj' 'bj'；同一点数多张时花色依次取 ♠♥♣♦ */
function hand(spec: string, offset = 0): Card[] {
  const suits: CardSuit[] = ['S', 'H', 'C', 'D'];
  const used = new Map<number, number>();
  return spec.split(' ').filter(Boolean).map((t) => {
    if (t === 'sj') return { id: cardId('J', SMALL_JOKER, 0), suit: 'J', rank: SMALL_JOKER, deck: 0 };
    if (t === 'bj') return { id: cardId('J', BIG_JOKER, 0), suit: 'J', rank: BIG_JOKER, deck: 0 };
    const rank = ({ J: 11, Q: 12, K: 13, A: 14 } as Record<string, number>)[t] ?? Number(t);
    const k = used.get(rank) ?? 0;
    used.set(rank, k + 1);
    const suit = suits[(k + offset) % 4] as CardSuit;
    return { id: cardId(suit, rank, 0), suit, rank, deck: 0 };
  });
}
const type = (spec: string) => classifyDdz(hand(spec))[0]?.type ?? null;
const must = (r: ReturnType<typeof applyDdzAction>): DdzState => {
  if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`);
  return r.state;
};

describe('牌型', () => {
  it('认得各种牌型', () => {
    expect(type('3')).toBe('single');
    expect(type('2 2')).toBe('pair');
    expect(type('7 7 7')).toBe('triple');
    expect(type('7 7 7 3')).toBe('triple1');
    expect(type('7 7 7 3 3')).toBe('triple2');
    expect(type('3 4 5 6 7')).toBe('straight');
    expect(type('3 4 5 6 7 8 9 10 J Q K A')).toBe('straight');
    expect(type('3 3 4 4 5 5')).toBe('pairStraight');
    expect(type('3 3 3 4 4 4')).toBe('plane');
    expect(type('3 3 3 4 4 4 9 J')).toBe('plane1');
    expect(type('3 3 3 4 4 4 9 9 J J')).toBe('plane2');
    expect(type('6 6 6 6 3 9')).toBe('four2');
    expect(type('6 6 6 6 3 3 9 9')).toBe('four22');
    expect(type('8 8 8 8')).toBe('bomb');
    expect(type('sj bj')).toBe('rocket');
  });

  it('不成牌型的', () => {
    expect(type('3 4')).toBeNull();
    expect(type('3 4 5 6')).toBeNull();
    expect(type('10 J Q K A 2')).toBeNull(); // 顺子不能带 2
    expect(type('3 3 4 4')).toBeNull(); // 连对要三对
    expect(type('Q Q K K A A 2 2')).toBeNull();
    expect(type('7 7 7 3 4')).toBeNull(); // 三带二要带一对
    expect(type('K K K A A A 2 2 2')).toBeNull(); // 飞机不能有 2
  });

  it('一手牌能看成几种牌型时，首出按飞机算，跟牌时能管住哪种就算哪种', () => {
    const cards = hand('3 3 3 4 4 4 5 5 5 6 6 6');
    expect(classifyDdz(cards)[0]).toMatchObject({ type: 'plane', length: 4 });
    const lead = ddzComboFor(hand('7 7 7 8 8 8 9 9 9 J Q K'), null)!;
    expect(lead).toMatchObject({ type: 'plane1', length: 3, rank: 9 });
    expect(ddzComboFor(cards, lead)).toBeNull(); // 3-5 的飞机比 7-9 小
    const higher = ddzComboFor(hand('8 8 8 9 9 9 10 10 10 J J J'), lead);
    expect(higher).toMatchObject({ type: 'plane1', rank: 11 });
  });

  it('比大小：同牌型同长度比点数；炸弹管一切，王炸最大', () => {
    const c = (s: string) => classifyDdz(hand(s))[0]!;
    expect(ddzBeats(c('2'), c('A'))).toBe(true);
    expect(ddzBeats(c('bj'), c('sj'))).toBe(true);
    expect(ddzBeats(c('4 5 6 7 8'), c('3 4 5 6 7'))).toBe(true);
    expect(ddzBeats(c('4 5 6 7 8 9'), c('3 4 5 6 7'))).toBe(false); // 长度不一样
    expect(ddzBeats(c('3 3 3 3'), c('3 4 5 6 7 8 9 10 J Q K A'))).toBe(true);
    expect(ddzBeats(c('4 4 4 4'), c('3 3 3 3'))).toBe(true);
    expect(ddzBeats(c('sj bj'), c('2 2 2 2'))).toBe(true);
    expect(ddzBeats(c('2 2 2 2'), c('sj bj'))).toBe(false);
  });

  it('跟牌提示：同牌型从小到大，然后炸弹、王炸', () => {
    const lead = classifyDdz(hand('5 5'))[0]!;
    const opts = ddzFollowOptions(hand('3 3 7 7 9 9 9 K K K K sj bj'), lead);
    expect(opts.map((o) => o.type)).toEqual(['pair', 'pair', 'pair', 'bomb', 'rocket']);
    expect(opts.map((o) => o.rank)).toEqual([7, 9, 13, 13, 17]);
  });
});

/** 摆一个叫分阶段的局面：三个人的手牌和底牌 */
function setup(h0: string, h1: string, h2: string, bottom: string, firstBidder = 0): DdzState {
  const base = createDdzGame('fixed');
  // 底牌的花色从 ♦ 起排，免得和地主手里的同一张牌重复
  return { ...base, hands: [hand(h0), hand(h1), hand(h2)], bottom: hand(bottom, 3), firstBidder, turn: firstBidder, bids: [null, null, null] };
}

describe('叫分和出牌', () => {
  const H0 = '3 4 5 6 7 8 9 10 J Q K A 2 sj bj 3 4';
  const H1 = '5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q K';
  const H2 = '3 4 5 6 7 8 9 10 J Q K A 2 2 A K Q';

  it('每人叫一次，只能叫得更高，叫到 3 分直接当地主，拿走底牌并公开', () => {
    let s = setup(H0, H1, H2, 'A 2 3');
    s = must(applyDdzAction(s, { type: 'bid', seat: 0, points: 1 }));
    expect(applyDdzAction(s, { type: 'bid', seat: 1, points: 1 }).ok).toBe(false);
    expect(applyDdzAction(s, { type: 'bid', seat: 2, points: 2 }).ok).toBe(false); // 还没轮到
    s = must(applyDdzAction(s, { type: 'bid', seat: 1, points: 3 }));
    expect(s.phase).toBe('playing');
    expect(s.landlord).toBe(1);
    expect(s.bid).toBe(3);
    expect(s.hands[1]!.length).toBe(20);
    expect(s.turn).toBe(1);
    expect(ddzViewFor(s, 0).bottom?.length).toBe(3);
  });

  it('三个人都叫过，最高的当地主；都不叫就重发，下一个人先叫', () => {
    let s = setup(H0, H1, H2, 'A 2 3');
    s = must(applyDdzAction(s, { type: 'bid', seat: 0, points: 0 }));
    s = must(applyDdzAction(s, { type: 'bid', seat: 1, points: 2 }));
    s = must(applyDdzAction(s, { type: 'bid', seat: 2, points: 0 }));
    expect(s.landlord).toBe(1);
    expect(s.bid).toBe(2);
    let t = setup(H0, H1, H2, 'A 2 3', 2);
    t = must(applyDdzAction(t, { type: 'bid', seat: 2, points: 0 }));
    t = must(applyDdzAction(t, { type: 'bid', seat: 0, points: 0 }));
    const r = applyDdzAction(t, { type: 'bid', seat: 1, points: 0 });
    expect(r.ok && r.events.some((e) => e.type === 'redeal')).toBe(true);
    t = must(r);
    expect(t.phase).toBe('bidding');
    expect(t.firstBidder).toBe(0);
    expect(t.redeals).toBe(1);
    expect(t.hands.every((h) => h.length === 17)).toBe(true);
  });

  it('地主先出；自由出牌时不能不出；两家都不出就由最后出牌的人再自由出', () => {
    let s = setup(H0, H1, H2, 'A 2 3');
    s = must(applyDdzAction(s, { type: 'bid', seat: 0, points: 3 }));
    expect(applyDdzAction(s, { type: 'pass', seat: 0 }).ok).toBe(false);
    const three = s.hands[0]!.find((c) => c.rank === 3)!;
    s = must(applyDdzAction(s, { type: 'play', seat: 0, cards: [three.id] }));
    // 管不住、牌型不对都不行
    const pairOf5 = s.hands[1]!.filter((c) => c.rank === 5);
    expect(applyDdzAction(s, { type: 'play', seat: 1, cards: pairOf5.map((c) => c.id) }).ok).toBe(false);
    s = must(applyDdzAction(s, { type: 'pass', seat: 1 }));
    s = must(applyDdzAction(s, { type: 'pass', seat: 2 }));
    expect(s.turn).toBe(0);
    expect(s.lastPlay).toBeNull();
    expect(s.roundPlays).toEqual([]);
  });

  it('计分：底分 × 2 的（炸弹数 + 春天）次方；地主得两份；春天', () => {
    let s = setup('4 5 6 7 8 9 10 J Q K A 2 2 2 sj bj 4', H1, H2, '2 3 3');
    s = must(applyDdzAction(s, { type: 'bid', seat: 0, points: 2 }));
    s = must(applyDdzAction(s, { type: 'bid', seat: 1, points: 0 }));
    s = must(applyDdzAction(s, { type: 'bid', seat: 2, points: 0 }));
    // 地主依次出王炸、4 到 A 的顺子、四个 2 的炸弹、一对 3、一张 4，农民一张没出
    const plays: ((c: Card, i: number, all: Card[]) => boolean)[] = [
      (c) => c.suit === 'J',
      (c, i, all) => c.rank >= 4 && c.rank <= 14 && all.findIndex((x) => x.rank === c.rank) === i,
      (c) => c.rank === 2,
      (c) => c.rank === 3,
      () => true,
    ];
    for (const pick of plays) {
      const hand0 = s.hands[0]!;
      s = must(applyDdzAction(s, { type: 'play', seat: 0, cards: hand0.filter((c, i) => pick(c, i, [...hand0])).map((c) => c.id) }));
      if (s.phase === 'roundEnd') break;
      s = must(applyDdzAction(s, { type: 'pass', seat: 1 }));
      s = must(applyDdzAction(s, { type: 'pass', seat: 2 }));
    }
    expect(s.phase).toBe('roundEnd');
    expect(s.lastRound).toMatchObject({ landlord: 0, landlordWon: true, spring: 'spring', bombs: 2, multiple: 8 });
    expect(s.lastRound?.deltas).toEqual([32, -16, -16]);
    expect(s.scores).toEqual([32, -16, -16]);
  });

  it('反春：地主只出了第一手，农民赢', () => {
    let s = setup('3 4 6 8 10 Q A 5 7 9 J K 2 3 4 6 8', '5 6 7 8 9 10 J Q K A 2 2 sj bj 5 5 5', H2, 'Q Q Q');
    s = must(applyDdzAction(s, { type: 'bid', seat: 0, points: 1 }));
    s = must(applyDdzAction(s, { type: 'bid', seat: 1, points: 0 }));
    s = must(applyDdzAction(s, { type: 'bid', seat: 2, points: 0 }));
    const three = s.hands[0]!.find((c) => c.rank === 3)!;
    s = must(applyDdzAction(s, { type: 'play', seat: 0, cards: [three.id] }));
    const bigJoker = s.hands[1]!.find((c) => c.rank === BIG_JOKER)!;
    s = must(applyDdzAction(s, { type: 'play', seat: 1, cards: [bigJoker.id] }));
    s = must(applyDdzAction(s, { type: 'pass', seat: 2 }));
    s = must(applyDdzAction(s, { type: 'pass', seat: 0 }));
    // 农民 1 号位：顺子 5 到 A，再三个 5 带对 2，最后小王
    const h1 = () => s.hands[1]!;
    const firstOf = (r: number) => h1().find((c) => c.rank === r)!;
    s = must(applyDdzAction(s, { type: 'play', seat: 1, cards: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((r) => firstOf(r).id) }));
    s = must(applyDdzAction(s, { type: 'pass', seat: 2 }));
    s = must(applyDdzAction(s, { type: 'pass', seat: 0 }));
    s = must(applyDdzAction(s, { type: 'play', seat: 1, cards: h1().filter((c) => c.rank === 5 || c.rank === 2).map((c) => c.id) }));
    s = must(applyDdzAction(s, { type: 'pass', seat: 2 }));
    s = must(applyDdzAction(s, { type: 'pass', seat: 0 }));
    s = must(applyDdzAction(s, { type: 'play', seat: 1, cards: h1().map((c) => c.id) }));
    expect(s.lastRound).toMatchObject({ landlord: 0, landlordWon: false, spring: 'antiSpring', bombs: 0, multiple: 2 });
    expect(s.lastRound?.deltas).toEqual([-4, 2, 2]);
  });

  it('机器人自对弈：每局都能打完，积分总和为零', () => {
    let s = createDdzGame('ddz-sim');
    let rounds = 0;
    for (let guard = 0; rounds < 200; guard++) {
      if (guard > 200_000) throw new Error('打不完');
      if (s.phase === 'roundEnd') {
        rounds++;
        expect(s.scores.reduce((a, b) => a + b, 0)).toBe(0);
        s = must(applyDdzAction(s, { type: 'nextRound' }));
        continue;
      }
      s = must(applyDdzAction(s, ddzBotAction(s, s.turn)!));
      const cards = s.hands.reduce((a, h) => a + h.length, 0) + (s.landlord === null ? 3 : 0);
      expect(cards).toBeLessThanOrEqual(54);
    }
  });

  it('机器人把手牌拆成尽量少的几手', () => {
    const plan = planDdzHand(hand('3 4 5 6 7 9 9 9 J J Q Q K K 2 sj bj'));
    expect(plan.map((g) => g.type).sort()).toEqual(['pairStraight', 'rocket', 'single', 'straight', 'triple'].sort());
  });
});
