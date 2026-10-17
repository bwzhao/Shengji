import { describe, expect, it } from 'vitest';
import { createGame, defaultConfig, levelRank, LEVEL_SEQUENCE } from '@shengji/engine';
import { migrateDealerRule, migrateLadder } from '../src/room.ts';

describe('旧存档的四人局换成新等级阶梯', () => {
  it('按点数换算等级下标，显示的级别不变；找朋友局不动', () => {
    const { levelSequence: _a, levelStops: _b, ...oldConfig } = defaultConfig(4);
    // 旧阶梯下标：0 = 5、1 = 10、3 = 2、12 = A
    const old = { ...createGame(oldConfig as ReturnType<typeof defaultConfig>, 'old'), levels: [1, 3, 1, 12] };
    const migrated = migrateLadder(old);
    expect(migrated.config.levelSequence).toEqual(defaultConfig(4).levelSequence);
    expect(migrated.levels.map((i) => levelRank(i, migrated.config))).toEqual([10, 2, 10, 14]);
    expect(old.levels.map((i) => LEVEL_SEQUENCE[i])).toEqual([10, 2, 10, 14]);
    const friends = createGame(defaultConfig(6), 'f');
    expect(migrateLadder(friends)).toBe(friends);
  });
});

describe('旧存档的五人局补上连庄规则', () => {
  it('五人局补上，六人局和已有设置不动', () => {
    const { dealerKeepsOnHold: _k, ...oldConfig } = defaultConfig(5);
    const old = createGame(oldConfig as ReturnType<typeof defaultConfig>, 'old5');
    expect(migrateDealerRule(old).config.dealerKeepsOnHold).toBe(true);
    const six = createGame(defaultConfig(6), 's');
    expect(migrateDealerRule(six)).toBe(six);
    const fresh = createGame(defaultConfig(5), 'f');
    expect(migrateDealerRule(fresh)).toBe(fresh);
  });
});
