/**
 * 等级阶梯。找朋友（五六人）：5 → 10 → K → 2 → 3 → 4 → 6 → 7 → 8 → 9 → J → Q → A。
 * 四人升级：2 → 3 → … → K → A，升级时不能越过 5、10、K（例如打 4 升两级只能到 5），
 * 而且这三级要庄上过：停在这一级时只有坐庄守住才能往上升，闲家上台只上庄、不升级。
 * 等级用阶梯下标表示；阶梯和必停的级别放在 GameConfig 里，旧存档里没有这两项时按找朋友的阶梯算。
 */
import type { GameConfig } from './config.ts';

export const LEVEL_SEQUENCE: readonly number[] = [5, 10, 13, 2, 3, 4, 6, 7, 8, 9, 11, 12, 14];
/** 四人升级的阶梯：从 2 打到 A */
export const PARTNERS_LEVEL_SEQUENCE: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
/** 四人升级必停的级别：升级时不能越过 */
export const PARTNERS_LEVEL_STOPS: readonly number[] = [5, 10, 13];
export const MAX_LEVEL_INDEX = LEVEL_SEQUENCE.length - 1;

/** 等级用阶梯下标表示，0 是起点，最后一个是 A。 */
export type LevelIndex = number;

type LadderConfig = Pick<GameConfig, 'levelSequence' | 'levelStops'> | undefined;

function sequenceOf(cfg: LadderConfig): readonly number[] {
  return cfg?.levelSequence ?? LEVEL_SEQUENCE;
}

export function levelRank(idx: LevelIndex, cfg?: LadderConfig): number {
  const r = sequenceOf(cfg)[idx];
  if (r === undefined) throw new Error(`invalid level index ${idx}`);
  return r;
}

/**
 * 升 steps 级；到 A 为止；途中遇到必停的级别就停在那里。
 * 必停的级别要庄上过：heldAsDealer 为 false（闲家上台）时，停在必停级别上的一方不动。
 */
export function advanceLevel(idx: LevelIndex, steps: number, cfg?: LadderConfig, heldAsDealer = true): LevelIndex {
  const seq = sequenceOf(cfg);
  const target = Math.min(seq.length - 1, idx + Math.max(0, steps));
  const stops = cfg?.levelStops ?? [];
  if (!heldAsDealer && stops.includes(seq[idx] as number)) return idx;
  for (let k = idx + 1; k < target; k++) if (stops.includes(seq[k] as number)) return k;
  return target;
}

export function isTopLevel(idx: LevelIndex, cfg?: LadderConfig): boolean {
  return idx >= sequenceOf(cfg).length - 1;
}
