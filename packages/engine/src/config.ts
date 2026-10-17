import { LEVEL_SEQUENCE, PARTNERS_LEVEL_SEQUENCE, PARTNERS_LEVEL_STOPS } from './levels.ts';
/** 一局游戏的规则配置。存在地方差异的规则全部放在这里。 */

export type PlayerCount = 4 | 5 | 6;

/** friends：找朋友，庄家叫朋友组队；partners：四人对家固定一队 */
export type GameMode = 'friends' | 'partners';

export interface GameConfig {
  readonly players: PlayerCount;
  readonly mode: GameMode;
  readonly decks: number;
  /** 底牌张数 */
  readonly bottomSize: number;
  /** 叫朋友的个数 */
  readonly friendCount: number;
  /** 计分一级的分数，下庄线为两级 */
  readonly levelStep: number;
  /** 甩牌失败每张罚分 */
  readonly throwPenaltyPerCard: number;
  /** 抠底倍数：按最后一墩首出的最高牌型 */
  readonly bottomMultiplier: {
    readonly single: number;
    readonly pair: number;
    readonly triple: number;
    readonly tractor: number;
  };
  /** 同张数是否可以反主。默认 false：只看张数，同张数先亮者有效 */
  readonly allowEqualCountOverride: boolean;
  /** 庄家自己打出的朋友牌是否计入序号 */
  readonly dealerCountsForFriend: boolean;
  /** 首局无人亮主时重发 */
  readonly redealIfNoDeclarerFirstRound: boolean;
  /** 等级阶梯（点数），下标 0 是起点、最后一个是 A。旧存档里没有这一项时按找朋友的阶梯 */
  readonly levelSequence?: readonly number[];
  /** 升级时不能越过的级别（点数） */
  readonly levelStops?: readonly number[];
  /** 庄家阵营守住时原庄家连庄（五人找朋友）；不设时交给最近的朋友 */
  readonly dealerKeepsOnHold?: boolean;
}

export const TOTAL_POINTS_PER_DECK = 100;

export function defaultConfig(players: PlayerCount): GameConfig {
  if (players === 4) {
    // 四人对家：两副牌，每人 25 张，底牌 8 张，总分 200，40 分一级、80 分下庄
    return {
      players: 4,
      mode: 'partners',
      decks: 2,
      bottomSize: 8,
      friendCount: 0,
      levelStep: 40,
      throwPenaltyPerCard: 10,
      bottomMultiplier: { single: 2, pair: 4, triple: 8, tractor: 8 },
      // 四人升级：一对王可以盖一对级牌，一对大王盖一对小王
      allowEqualCountOverride: true,
      dealerCountsForFriend: true,
      redealIfNoDeclarerFirstRound: true,
      // 四人升级从 2 打到 A；第一次到 5、10、K 不能跳过
      levelSequence: PARTNERS_LEVEL_SEQUENCE,
      levelStops: PARTNERS_LEVEL_STOPS,
    };
  }
  const five = players === 5;
  return {
    players,
    mode: 'friends',
    decks: 3,
    bottomSize: five ? 7 : 6,
    friendCount: five ? 1 : 2,
    levelStep: five ? 60 : 50,
    throwPenaltyPerCard: 10,
    bottomMultiplier: { single: 2, pair: 4, triple: 8, tractor: 8 },
    allowEqualCountOverride: false,
    dealerCountsForFriend: true,
    redealIfNoDeclarerFirstRound: true,
    levelSequence: LEVEL_SEQUENCE,
    levelStops: [],
    // 五人找朋友守住就连庄，下庄仍交给第一个闲家
    dealerKeepsOnHold: five,
  };
}

export function handSize(cfg: GameConfig): number {
  const total = cfg.decks * 54;
  const perHand = (total - cfg.bottomSize) / cfg.players;
  if (!Number.isInteger(perHand)) {
    throw new Error(`牌数不能整除：${total} 张减 ${cfg.bottomSize} 张底牌无法平分给 ${cfg.players} 人`);
  }
  return perHand;
}
