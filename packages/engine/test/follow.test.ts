import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decompose } from '../src/combos.ts';
import { generateFollow, validateFollow } from '../src/follow.ts';
import { makeDeck } from '../src/cards.ts';
import { createRng } from '../src/rng.ts';
import { groupOf, type TrumpCtx } from '../src/trump.ts';
import { H5, cs, more, resetDecks } from './helpers.ts';
import type { Card } from '../src/cards.ts';
import type { Group } from '../src/trump.ts';

function lead(names: string, ctx: TrumpCtx = H5) {
  resetDecks();
  const d = decompose(more(names), ctx);
  if (!d) throw new Error('lead 分解失败');
  return d;
}

function code(names: string, hand: Card[], play: string, ctx: TrumpCtx = H5): string | null {
  const l = lead(names, ctx);
  resetDecks();
  const handCards = more(hand.map((c) => `${{ S: '♠', H: '♥', D: '♦', C: '♣', J: '' }[c.suit]}${c.rank === 15 ? 'SJ' : c.rank === 16 ? 'BJ' : { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[c.rank] ?? c.rank}`).join(' '));
  const byName = new Map<string, Card[]>();
  for (const c of handCards) {
    const k = `${c.suit}${c.rank}`;
    const arr = byName.get(k);
    if (arr) arr.push(c); else byName.set(k, [c]);
  }
  const playCards = play.trim().split(/\s+/).map((n) => {
    const tmp = cs(n)[0] as Card;
    const arr = byName.get(`${tmp.suit}${tmp.rank}`);
    const c = arr?.shift();
    if (!c) throw new Error(`手里没有 ${n}`);
    return c;
  });
  const err = validateFollow(l, handCards, playCards, ctx);
  return err ? err.code : null;
}

describe('跟牌校验', () => {
  it('有该花色必须跟该花色', () => {
    const hand = cs('♠K ♠K ♠Q ♥3');
    expect(code('♠A ♠A', hand, '♠K ♥3')).toBe('MUST_FOLLOW_SUIT');
    expect(code('♠A ♠A', hand, '♠K ♠Q')).toBe('MUST_MATCH_STRUCTURE');
    expect(code('♠A ♠A', hand, '♠K ♠K')).toBeNull();
  });

  it('该花色不够时全部出完再用别的补', () => {
    const hand = cs('♠Q ♥3 ♥4');
    expect(code('♠A ♠A', hand, '♠Q ♥3')).toBeNull();
    expect(code('♠A ♠A', hand, '♥3 ♥4')).toBe('MUST_FOLLOW_SUIT');
  });

  it('首出拖拉机，有同长拖拉机必须出', () => {
    const hand = cs('♠Q ♠Q ♠J ♠J ♠9 ♠9');
    expect(code('♠A ♠A ♠K ♠K', hand, '♠Q ♠Q ♠9 ♠9')).toBe('MUST_MATCH_STRUCTURE');
    expect(code('♠A ♠A ♠K ♠K', hand, '♠Q ♠Q ♠J ♠J')).toBeNull();
  });

  it('没有拖拉机时必须尽量出对子', () => {
    const hand = cs('♠Q ♠Q ♠9 ♠9 ♠8 ♠7');
    expect(code('♠A ♠A ♠K ♠K', hand, '♠Q ♠Q ♠8 ♠7')).toBe('MUST_MATCH_STRUCTURE');
    expect(code('♠A ♠A ♠K ♠K', hand, '♠Q ♠Q ♠9 ♠9')).toBeNull();
  });

  it('首出三条，没有三条时对子加单张', () => {
    const hand = cs('♠K ♠K ♠Q ♠J');
    expect(code('♠A ♠A ♠A', hand, '♠K ♠Q ♠J')).toBe('MUST_MATCH_STRUCTURE');
    expect(code('♠A ♠A ♠A', hand, '♠K ♠K ♠Q')).toBeNull();
  });

  it('三条不必拆开跟对子或对子拖拉机，自愿拆开也合法', () => {
    const hand = cs('♠A ♠A ♠A ♠K ♠K ♠K');
    expect(code('♠Q ♠Q ♠J ♠J', hand, '♠A ♠A ♠A ♠K')).toBeNull();
    expect(code('♠Q ♠Q ♠J ♠J', hand, '♠A ♠A ♠K ♠K')).toBeNull();
    const hand2 = cs('♠A ♠A ♠A ♠9 ♠3');
    expect(code('♠K ♠K', hand2, '♠9 ♠3')).toBeNull();
    expect(code('♠K ♠K', hand2, '♠A ♠A')).toBeNull();
  });

  it('有纯对子时仍然必须跟对子', () => {
    const hand = cs('♠A ♠A ♠A ♠9 ♠9 ♠3');
    expect(code('♠K ♠K', hand, '♠A ♠3')).toBe('MUST_MATCH_STRUCTURE');
    expect(code('♠K ♠K', hand, '♠9 ♠9')).toBeNull();
    expect(code('♠K ♠K', hand, '♠A ♠A')).toBeNull();
  });

  it('张数必须一致', () => {
    const hand = cs('♠K ♠Q ♠J');
    expect(code('♠A ♠A', hand, '♠K')).toBe('WRONG_CARD_COUNT');
  });

  it('没有该花色时随意出', () => {
    const hand = cs('♥3 ♣4 ♦9');
    expect(code('♠A ♠A', hand, '♥3 ♦9')).toBeNull();
  });
});

describe('生成的跟牌一定合法', () => {
  it('随机手牌与首出', () => {
    const deck = makeDeck(3);
    fc.assert(
      fc.property(fc.nat(), fc.constantFrom<TrumpCtx>(H5, { level: 10, trumpSuit: 'S' }, { level: 14, trumpSuit: null }, { level: 2, trumpSuit: 'C' }), (seed, ctx) => {
        const rng = createRng(`follow-${seed}`);
        const shuffled = rng.shuffle(deck);
        const a = shuffled.slice(0, 26), b = shuffled.slice(26, 52);
        const byGroup = new Map<Group, Card[]>();
        for (const c of a) {
          const g = groupOf(c, ctx);
          const arr = byGroup.get(g);
          if (arr) arr.push(c); else byGroup.set(g, [c]);
        }
        const groupCards = rng.pick([...byGroup.values()]);
        const d = decompose(groupCards, ctx);
        if (!d) return true;
        const comps = rng.shuffle([...d.components]).slice(0, rng.next() < 0.3 ? 2 : 1);
        const leadCards = comps.flatMap((c) => [...c.cards]);
        const leadD = decompose(leadCards, ctx);
        if (!leadD) throw new Error('lead 分解失败');
        const play = generateFollow(leadD, b, ctx, rng);
        const err = validateFollow(leadD, b, play, ctx);
        if (err) throw new Error(`${err.code}: ${err.message}`);
        return true;
      }),
      { numRuns: 2000 },
    );
  });
});

describe('跟拖拉机（#16 里的例子）', () => {
  // 级牌 2、红桃主，例子里的 A K Q 10 9 5 4 都是普通黑桃
  const ctx2: TrumpCtx = { level: 2, trumpSuit: 'H' };
  const RANK: Record<string, number> = { J: 11, Q: 12, K: 13, A: 14 };
  /** 从手牌里按点数依次取黑桃，比如 '10 10 9 9' */
  const pick = (hand: readonly Card[], spec: string): Card[] => {
    const left = [...hand];
    return spec.split(/\s+/).map((r) => {
      const i = left.findIndex((c) => c.suit === 'S' && c.rank === (RANK[r] ?? Number(r)));
      return left.splice(i, 1)[0] as Card;
    });
  };
  const ok = (leadSpec: string, handSpec: string, play: string): boolean => {
    const hand = cs(handSpec);
    const lead = decompose(more(leadSpec), ctx2)!;
    return validateFollow(lead, hand, pick(hand, play), ctx2) === null;
  };
  const HAND = '♠10 ♠10 ♠9 ♠9 ♠9 ♠5 ♠5 ♠4 ♦3 ♦7';

  it('首出 AAKK、手里 10 10 9 9 9 5 5 4：要出两对，三条可以不拆', () => {
    for (const p of ['10 10 9 9', '10 10 5 5', '9 9 5 5']) expect(ok('♠A ♠A ♠K ♠K', HAND, p)).toBe(true);
    for (const p of ['9 9 9 4', '9 4 5 5', '9 4 10 10']) expect(ok('♠A ♠A ♠K ♠K', HAND, p)).toBe(false);
  });

  it('首出 AAKKQQ、手里 10 10 9 9 9 5 5 4：纯对子都要出，拆三条不影响要出的对子数', () => {
    for (const p of ['10 10 9 9 5 5', '10 10 9 5 5 4']) expect(ok('♠A ♠A ♠K ♠K ♠Q ♠Q', HAND, p)).toBe(true);
    for (const p of ['10 10 9 9 9 4', '5 5 9 9 9 4']) expect(ok('♠A ♠A ♠K ♠K ♠Q ♠Q', HAND, p)).toBe(false);
  });

  it('不同长的拖拉机也必须跟：长的拆一段出，短的整个出', () => {
    // 首出两节，手里有三节：必须出其中相连的两节
    expect(ok('♠A ♠A ♠K ♠K', '♠10 ♠10 ♠9 ♠9 ♠8 ♠8 ♠4 ♦3', '10 10 8 8')).toBe(false);
    expect(ok('♠A ♠A ♠K ♠K', '♠10 ♠10 ♠9 ♠9 ♠8 ♠8 ♠4 ♦3', '9 9 8 8')).toBe(true);
    // 首出三节，手里只有两节：两节必须出，再补一对
    expect(ok('♠A ♠A ♠K ♠K ♠Q ♠Q', '♠10 ♠10 ♠9 ♠9 ♠5 ♠5 ♠7 ♠7 ♦3', '10 10 5 5 7 7')).toBe(false);
    expect(ok('♠A ♠A ♠K ♠K ♠Q ♠Q', '♠10 ♠10 ♠9 ♠9 ♠5 ♠5 ♠7 ♠7 ♦3', '10 10 9 9 5 5')).toBe(true);
  });

  it('跟连续三条（泰坦尼克）：有三条出三条，没有三条给对子', () => {
    expect(ok('♠A ♠A ♠A ♠K ♠K ♠K', '♠9 ♠9 ♠9 ♠5 ♠5 ♠4 ♠4 ♠3 ♦3', '9 9 9 5 5 4')).toBe(true);
    expect(ok('♠A ♠A ♠A ♠K ♠K ♠K', '♠9 ♠9 ♠9 ♠5 ♠5 ♠4 ♠4 ♠3 ♦3', '9 9 5 5 4 4')).toBe(false);
    expect(ok('♠A ♠A ♠A ♠K ♠K ♠K', '♠9 ♠9 ♠5 ♠5 ♠4 ♠4 ♠3 ♠6 ♦3', '9 9 5 5 4 3')).toBe(true);
    expect(ok('♠A ♠A ♠A ♠K ♠K ♠K', '♠9 ♠9 ♠5 ♠5 ♠4 ♠4 ♠3 ♠6 ♦3', '9 5 4 3 6 5')).toBe(false);
  });
});
