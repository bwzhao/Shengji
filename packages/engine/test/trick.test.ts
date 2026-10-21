import { describe, expect, it } from 'vitest';
import { decompose } from '../src/combos.ts';
import { bottomMultiplier, trickWinner } from '../src/trick.ts';
import { H5, more, resetDecks } from './helpers.ts';
import type { TrumpCtx } from '../src/trump.ts';

function winner(plays: string[], ctx: TrumpCtx = H5): number {
  resetDecks();
  const tp = plays.map((p, i) => ({ seat: i, cards: more(p) }));
  const lead = decompose(tp[0]?.cards ?? [], ctx);
  if (!lead) throw new Error('首出分解失败');
  return trickWinner(tp, lead, ctx);
}

describe('赢墩判定', () => {
  it('同花色比大小，别的副牌花色不能赢', () => {
    expect(winner(['♠K', '♠A', '♣A'])).toBe(1);
    expect(winner(['♠A', '♠K', '♣A'])).toBe(0);
  });

  it('主牌毙副牌，主牌之间比序位', () => {
    expect(winner(['♠A', '♠K', '♥2'])).toBe(2);
    expect(winner(['♠A', '♥3', '♥A', '♠5'])).toBe(3);
    expect(winner(['♠A', '♠5', '♥5'])).toBe(2);
    expect(winner(['♠A', '♥5', 'SJ', 'BJ'])).toBe(3);
  });

  it('相同大小先出者赢', () => {
    expect(winner(['♠A', '♠A'])).toBe(0);
    expect(winner(['♠A', '♠5', '♦5'])).toBe(1);
  });

  it('对子只能被对子压', () => {
    expect(winner(['♠K ♠K', '♠A ♠Q', '♠A ♠A'])).toBe(2);
    expect(winner(['♠K ♠K', '♠A ♠Q'])).toBe(0);
    expect(winner(['♠K ♠K', '♥2 ♥3'])).toBe(0);
    expect(winner(['♠K ♠K', '♥2 ♥2'])).toBe(1);
  });

  it('拖拉机只能被同长拖拉机压', () => {
    expect(winner(['♠K ♠K ♠Q ♠Q', '♠A ♠A ♠J ♠J', '♥3 ♥3 ♥4 ♥4'])).toBe(2);
    expect(winner(['♠K ♠K ♠Q ♠Q', '♠A ♠A ♠J ♠J'])).toBe(0);
    expect(winner(['♠Q ♠Q ♠J ♠J', '♠A ♠A ♠K ♠K'])).toBe(1);
  });

  it('甩牌被压时比最高的组件，三条可以拆开盖住对子加单张', () => {
    expect(winner(['♠K ♠K ♠3', '♠A ♠A ♠2'])).toBe(1);
    expect(winner(['♠K ♠K ♠3', '♠A ♠2 ♠4'])).toBe(0);
    expect(winner(['♠K ♠K ♠3', '♠A ♠A ♠A'])).toBe(1);
    expect(winner(['♠K ♠K ♠3', '♥7 ♥7 ♥2'])).toBe(1);
    expect(winner(['♠K ♠K ♠3', '♥7 ♥8 ♥2'])).toBe(0);
  });

  it('抠底倍数是 2 的 n 次方，n 是首出里最大单一牌型的张数，上不封顶', () => {
    const d = (s: string) => { resetDecks(); return decompose(more(s), H5)!; };
    expect(bottomMultiplier(d('♠A'))).toBe(2);
    expect(bottomMultiplier(d('♠A ♠A'))).toBe(4);
    expect(bottomMultiplier(d('♠A ♠A ♠A'))).toBe(8);
    expect(bottomMultiplier(d('♠A ♠A ♠K ♠K'))).toBe(16);
    expect(bottomMultiplier(d('♠A ♠A ♠K ♠K ♠Q ♠Q'))).toBe(64);
    // 连续三条（泰坦尼克）
    expect(bottomMultiplier(d('♠A ♠A ♠A ♠K ♠K ♠K'))).toBe(64);
    // 甩牌按其中最大的牌型
    expect(bottomMultiplier(d('♠A ♠K ♠3'))).toBe(2);
    expect(bottomMultiplier(d('♠A ♠A ♠3'))).toBe(4);
    expect(bottomMultiplier(d('♠A ♠A ♠K ♠K ♠3'))).toBe(16);
  });
});
