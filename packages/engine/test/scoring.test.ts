import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.ts';
import { LEVEL_SEQUENCE, advanceLevel, levelRank } from '../src/levels.ts';
import { scoreRound } from '../src/scoring.ts';

describe('结算阶梯', () => {
  it('5 人 60 分一级，120 下庄', () => {
    const cfg = defaultConfig(5);
    expect(scoreRound(0, cfg)).toEqual({ dealerHeld: true, levelsUp: 3 });
    expect(scoreRound(5, cfg)).toEqual({ dealerHeld: true, levelsUp: 2 });
    expect(scoreRound(59, cfg)).toEqual({ dealerHeld: true, levelsUp: 2 });
    expect(scoreRound(60, cfg)).toEqual({ dealerHeld: true, levelsUp: 1 });
    expect(scoreRound(119, cfg)).toEqual({ dealerHeld: true, levelsUp: 1 });
    expect(scoreRound(120, cfg)).toEqual({ dealerHeld: false, levelsUp: 0 });
    expect(scoreRound(179, cfg)).toEqual({ dealerHeld: false, levelsUp: 0 });
    expect(scoreRound(180, cfg)).toEqual({ dealerHeld: false, levelsUp: 1 });
    expect(scoreRound(240, cfg)).toEqual({ dealerHeld: false, levelsUp: 2 });
    expect(scoreRound(300, cfg)).toEqual({ dealerHeld: false, levelsUp: 3 });
  });

  it('6 人 50 分一级，100 下庄', () => {
    const cfg = defaultConfig(6);
    expect(scoreRound(0, cfg)).toEqual({ dealerHeld: true, levelsUp: 3 });
    expect(scoreRound(49, cfg)).toEqual({ dealerHeld: true, levelsUp: 2 });
    expect(scoreRound(50, cfg)).toEqual({ dealerHeld: true, levelsUp: 1 });
    expect(scoreRound(100, cfg)).toEqual({ dealerHeld: false, levelsUp: 0 });
    expect(scoreRound(150, cfg)).toEqual({ dealerHeld: false, levelsUp: 1 });
    expect(scoreRound(300, cfg)).toEqual({ dealerHeld: false, levelsUp: 4 });
  });

  it('等级顺序 5 10 K 2 3 4 6 7 8 9 J Q A', () => {
    expect(LEVEL_SEQUENCE).toEqual([5, 10, 13, 2, 3, 4, 6, 7, 8, 9, 11, 12, 14]);
    expect(levelRank(0)).toBe(5);
    expect(levelRank(advanceLevel(0, 2))).toBe(13);
    expect(levelRank(advanceLevel(11, 5))).toBe(14);
  });
});

describe('四人升级的等级阶梯', () => {
  const cfg = defaultConfig(4);
  const idx = (rank: number) => (cfg.levelSequence as readonly number[]).indexOf(rank);
  const up = (from: number, steps: number) => levelRank(advanceLevel(idx(from), steps, cfg), cfg);
  it('从 2 开始、A 结束', () => {
    expect(levelRank(0, cfg)).toBe(2);
    expect(up(13, 3)).toBe(14);
    expect(up(14, 2)).toBe(14);
  });
  it('第一次到 5、10、K 不能跳过', () => {
    expect(up(4, 2)).toBe(5);
    expect(up(3, 3)).toBe(5);
    expect(up(2, 1)).toBe(3);
    expect(up(5, 2)).toBe(7);
    expect(up(8, 3)).toBe(10);
    expect(up(10, 2)).toBe(12);
    expect(up(12, 3)).toBe(13);
    expect(up(13, 1)).toBe(14);
  });
  it('5、10、K 要庄上过：闲家上台停在这三级不动', () => {
    const opp = (from: number, steps: number) => levelRank(advanceLevel(idx(from), steps, cfg, false), cfg);
    expect(opp(5, 1)).toBe(5);
    expect(opp(10, 3)).toBe(10);
    expect(opp(13, 2)).toBe(13);
    // 闲家上台也不能越过必停的级别
    expect(opp(4, 2)).toBe(5);
    expect(opp(8, 3)).toBe(10);
    expect(opp(12, 1)).toBe(13);
    // 不在必停级别上照常升级
    expect(opp(6, 2)).toBe(8);
    // 坐庄守住才能升过去
    expect(up(5, 1)).toBe(6);
    expect(up(10, 1)).toBe(11);
    expect(up(13, 1)).toBe(14);
  });
  it('找朋友的阶梯不变', () => {
    const f = defaultConfig(6);
    expect(levelRank(advanceLevel(0, 2, f), f)).toBe(13);
    expect(levelRank(advanceLevel(2, 2, f), f)).toBe(3);
    // 找朋友没有必停的级别，闲家上台照常升级
    expect(levelRank(advanceLevel(0, 2, f, false), f)).toBe(13);
  });
});
