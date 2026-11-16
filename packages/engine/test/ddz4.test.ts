/** 四人斗地主（两副牌）：牌型、炸弹大小、天王炸、发牌、计分、机器人自对弈。 */
import { describe, expect, it } from 'vitest';
import { BIG_JOKER, SMALL_JOKER, cardId, type Card, type CardSuit } from '../src/cards.ts';
import {
  applyDdzAction, classifyDdz, createDdzGame, ddzBeats, ddzBidPoints, ddzBotAction, ddzComboFor, ddzComboName, ddzFollowOptions,
  ddzOptionsOfType, ddzViewFor, planDdzHand, type DdzState,
} from '../src/ddz/index.ts';

/** 牌的简写：'3' '10' 'J' 'A' '2' 'sj' 'bj'；同一点数多张时依次取 ♠♥♣♦，再换第二副 */
function hand(spec: string): Card[] {
  const suits: CardSuit[] = ['S', 'H', 'C', 'D'];
  const used = new Map<number, number>();
  return spec.split(' ').filter(Boolean).map((t) => {
    if (t === 'sj' || t === 'bj') {
      const rank = t === 'sj' ? SMALL_JOKER : BIG_JOKER;
      const k = used.get(rank) ?? 0;
      used.set(rank, k + 1);
      return { id: cardId('J', rank, k), suit: 'J', rank, deck: k };
    }
    const rank = ({ J: 11, Q: 12, K: 13, A: 14 } as Record<string, number>)[t] ?? Number(t);
    const k = used.get(rank) ?? 0;
    used.set(rank, k + 1);
    const suit = suits[k % 4] as CardSuit;
    const deck = Math.floor(k / 4);
    return { id: cardId(suit, rank, deck), suit, rank, deck };
  });
}
const type = (spec: string) => classifyDdz(hand(spec), 4)[0]?.type ?? null;
const combo = (spec: string) => ddzComboFor(hand(spec), null, 4)!;
const must = (r: ReturnType<typeof applyDdzAction>): DdzState => {
  if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`);
  return r.state;
};
const repeat = (r: string, k: number) => Array(k).fill(r).join(' ');

describe('四人牌型', () => {
  it('三张只能带一对、飞机只能带对子，没有三带一、飞机带单、四带二', () => {
    expect(type('7 7 7')).toBe('triple');
    expect(type('7 7 7 3 3')).toBe('triple2');
    expect(type('7 7 7 3')).toBeNull();
    expect(type('3 3 3 4 4 4')).toBe('plane');
    expect(type('3 3 3 4 4 4 9 9 J J')).toBe('plane2');
    expect(type('3 3 3 4 4 4 9 J')).toBeNull();
    expect(type('6 6 6 6 3 9')).toBeNull();
    expect(type('6 6 6 6 3 3 9 9')).toBeNull();
    expect(type('3 4 5 6 7')).toBe('straight');
    expect(type('3 3 4 4 5 5')).toBe('pairStraight');
    // 三人的规则不受影响
    expect(classifyDdz(hand('7 7 7 3'))[0]?.type).toBe('triple1');
  });

  it('炸弹 4 到 8 张，长度记张数', () => {
    for (let k = 4; k <= 8; k++) expect(classifyDdz(hand(repeat('9', k)), 4)[0]).toMatchObject({ type: 'bomb', rank: 9, length: k });
    // 三人只认四张的炸弹
    expect(classifyDdz(hand(repeat('9', 5)))).toEqual([]);
  });

  it('四个王是天王炸；大小王一对不是王炸，两张小王、两张大王是对子', () => {
    expect(type('sj sj bj bj')).toBe('rocket');
    expect(ddzComboName('rocket', 4)).toBe('天王炸');
    expect(ddzComboName('rocket')).toBe('王炸');
    expect(type('sj bj')).toBeNull();
    expect(type('sj sj bj')).toBeNull();
    expect(type('sj sj')).toBe('pair');
    expect(type('bj bj')).toBe('pair');
    expect(classifyDdz(hand('sj bj'))[0]?.type).toBe('rocket');
  });

  it('炸弹张数多的大，同张数比点数；天王炸最大', () => {
    expect(ddzBeats(combo(repeat('3', 5)), combo(repeat('2', 4)))).toBe(true);
    expect(ddzBeats(combo(repeat('2', 4)), combo(repeat('3', 5)))).toBe(false);
    expect(ddzBeats(combo(repeat('A', 4)), combo(repeat('K', 4)))).toBe(true);
    expect(ddzBeats(combo(repeat('K', 6)), combo(repeat('A', 6)))).toBe(false);
    expect(ddzBeats(combo('sj sj bj bj'), combo(repeat('2', 8)))).toBe(true);
    expect(ddzBeats(combo(repeat('2', 8)), combo('sj sj bj bj'))).toBe(false);
    expect(ddzBeats(combo(repeat('3', 4)), combo('2 2'))).toBe(true);
  });

  it('跟炸弹：只给管得住的炸弹，从小到大，最后天王炸', () => {
    const lead = combo(repeat('9', 5));
    const options = ddzFollowOptions(hand(`${repeat('3', 6)} ${repeat('10', 5)} ${repeat('A', 4)} sj sj bj bj`), lead, 4);
    expect(options.map((o) => [o.type, o.rank, o.cards.length])).toEqual([
      ['bomb', 10, 5], ['bomb', 3, 6], ['rocket', 17, 4],
    ]);
    // 首出提示里的炸弹也能拆成不同张数
    expect(ddzOptionsOfType(hand(repeat('7', 6)), 'bomb', 1, 4).map((o) => o.cards.length)).toEqual([4, 5, 6]);
    expect(ddzOptionsOfType(hand('7 7 7 3'), 'triple1', 1, 4)).toEqual([]);
  });
});

describe('四人对局', () => {
  it('两副牌 108 张：每人 25 张、底牌 8 张，地主拿底牌后 33 张', () => {
    let s = createDdzGame('four-deal', 4);
    expect(s.players).toBe(4);
    expect(s.hands.map((h) => h.length)).toEqual([25, 25, 25, 25]);
    expect(s.bottom).toHaveLength(8);
    const ids = new Set([...s.hands.flat(), ...s.bottom].map((c) => c.id));
    expect(ids.size).toBe(108);
    expect(s.bids).toEqual([null, null, null, null]);
    expect(ddzViewFor(s, 0).players).toBe(4);
    // 都叫过了，最高的当地主
    const first = s.firstBidder;
    const order = [0, 1, 2, 3].map((i) => (first + i) % 4);
    s = must(applyDdzAction(s, { type: 'bid', seat: order[0]!, points: 1 }));
    s = must(applyDdzAction(s, { type: 'bid', seat: order[1]!, points: 0 }));
    s = must(applyDdzAction(s, { type: 'bid', seat: order[2]!, points: 2 }));
    expect(s.phase).toBe('bidding');
    s = must(applyDdzAction(s, { type: 'bid', seat: order[3]!, points: 0 }));
    expect(s.phase).toBe('playing');
    expect(s.landlord).toBe(order[2]);
    expect(s.hands[order[2]!]).toHaveLength(33);
    expect(ddzViewFor(s, 0).bottom).toHaveLength(8);
  });

  it('三家都不出才轮回到出牌的人；地主赢每个农民输一份，地主得三份', () => {
    let s = createDdzGame('four-settle', 4);
    const first = s.firstBidder;
    s = must(applyDdzAction(s, { type: 'bid', seat: first, points: 3 }));
    const L = first;
    // 地主手里只留一张，出完就赢
    s = { ...s, hands: s.hands.map((h, i) => (i === L ? h.slice(0, 2) : h)) };
    s = must(applyDdzAction(s, { type: 'play', seat: L, cards: [s.hands[L]![0]!.id] }));
    for (let k = 1; k <= 2; k++) {
      s = must(applyDdzAction(s, { type: 'pass', seat: (L + k) % 4 }));
      expect(s.lastPlay).not.toBeNull();
    }
    s = must(applyDdzAction(s, { type: 'pass', seat: (L + 3) % 4 }));
    expect(s.lastPlay).toBeNull();
    expect(s.turn).toBe(L);
    s = must(applyDdzAction(s, { type: 'play', seat: L, cards: [s.hands[L]![0]!.id] }));
    expect(s.phase).toBe('roundEnd');
    // 农民一张没出：春天 ×2，底分 3
    expect(s.lastRound).toMatchObject({ landlord: L, landlordWon: true, spring: 'spring', multiple: 2 });
    expect(s.lastRound!.deltas[L]).toBe(18);
    expect(s.lastRound!.deltas.filter((_, i) => i !== L)).toEqual([-6, -6, -6]);
  });

  it('机器人自对弈：每局都能打完，出的都是四人允许的牌型，积分总和为零', () => {
    let s = createDdzGame('ddz4-sim', 4);
    let rounds = 0;
    const seen = new Set<string>();
    for (let guard = 0; rounds < 150; guard++) {
      if (guard > 300_000) throw new Error('打不完');
      if (s.phase === 'roundEnd') {
        rounds++;
        expect(s.scores.reduce((a, b) => a + b, 0)).toBe(0);
        expect(s.lastRound!.deltas[s.lastRound!.landlord]).toBe(-s.lastRound!.deltas.filter((_, i) => i !== s.lastRound!.landlord).reduce((a, b) => a + b, 0));
        s = must(applyDdzAction(s, { type: 'nextRound' }));
        continue;
      }
      const r = applyDdzAction(s, ddzBotAction(s, s.turn)!);
      if (!r.ok) throw new Error(`机器人出了不合法的牌：${r.error.message}`);
      for (const e of r.events) if (e.type === 'played') seen.add(e.combo);
      s = r.state;
      const cards = s.hands.reduce((a, h) => a + h.length, 0) + (s.landlord === null ? 8 : 0);
      expect(cards).toBeLessThanOrEqual(108);
    }
    for (const t of ['triple1', 'plane1', 'four2', 'four22']) expect(seen.has(t)).toBe(false);
    expect(seen.has('bomb')).toBe(true);
  });

  it('机器人拆牌：长炸弹整个留着，三张带对子', () => {
    const plan = planDdzHand(hand(`${repeat('9', 6)} 5 5 5 3 3 K`), 4);
    expect(plan.map((g) => [g.type, g.cards.length]).sort()).toEqual([['bomb', 6], ['single', 1], ['triple2', 5]].sort());
  });

  it('机器人叫分：好牌叫 3 分，烂牌不叫', () => {
    const strong = hand(`sj sj bj bj ${repeat('2', 5)} ${repeat('A', 4)} K K Q Q J J 10 10 9 9 8 8 7 7`);
    expect(ddzBidPoints(strong, 0, 4)).toBe(3);
    const weak = hand('3 3 4 5 5 6 7 7 8 9 9 10 J J Q 3 4 6 8 10 Q K 5 6 7');
    expect(ddzBidPoints(weak, 0, 4)).toBe(0);
  });
});
