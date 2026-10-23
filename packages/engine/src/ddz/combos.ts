/**
 * 斗地主牌型（GitHub：三人斗地主模式）。一副牌 54 张，点数从小到大 3 … K、A、2、小王、大王。
 * 牌型：单张、对子、三张、三带一、三带一对、顺子（5 张起）、连对（3 对起）、飞机（2 个三张起，可以带同样多的单张或对子）、
 * 四带二（两张单或两对）、炸弹、王炸。顺子、连对、飞机最大到 A，不能有 2 和王。
 */
import { BIG_JOKER, type Card } from '../cards.ts';

/** 斗地主点数：3..K = 3..13，A = 14，2 = 15，小王 = 16，大王 = 17 */
export function ddzRank(c: Card): number {
  if (c.suit === 'J') return c.rank === BIG_JOKER ? 17 : 16;
  return c.rank === 2 ? 15 : c.rank;
}

/** 点数的名字：3..10、J、Q、K、A、2、小王、大王 */
export function ddzRankName(rank: number): string {
  switch (rank) {
    case 11: return 'J';
    case 12: return 'Q';
    case 13: return 'K';
    case 14: return 'A';
    case 15: return '2';
    case 16: return '小王';
    case 17: return '大王';
    default: return String(rank);
  }
}

/** 顺子、连对、飞机最大到 A */
const CHAIN_MAX = 14;

export type DdzComboType =
  | 'single' | 'pair' | 'triple' | 'triple1' | 'triple2'
  | 'straight' | 'pairStraight' | 'plane' | 'plane1' | 'plane2'
  | 'four2' | 'four22' | 'bomb' | 'rocket';

export const DDZ_COMBO_NAME: Readonly<Record<DdzComboType, string>> = {
  single: '单张', pair: '对子', triple: '三张', triple1: '三带一', triple2: '三带一对',
  straight: '顺子', pairStraight: '连对', plane: '飞机', plane1: '飞机带单', plane2: '飞机带对',
  four2: '四带二', four22: '四带两对', bomb: '炸弹', rocket: '王炸',
};

export interface DdzCombo {
  readonly type: DdzComboType;
  /** 比大小用的点数：主体的点数，顺子、连对、飞机取最大的一节 */
  readonly rank: number;
  /** 连着的节数：顺子的张数、连对的对数、飞机的三张数；其余为 1 */
  readonly length: number;
  readonly cards: readonly Card[];
}

/** 打出这些牌时按哪种牌型算的优先顺序：一手牌能看成几种牌型时，首出按排在前面的算 */
const PRIORITY: readonly DdzComboType[] = [
  'rocket', 'bomb', 'plane', 'straight', 'pairStraight', 'plane2', 'plane1', 'four22', 'four2', 'triple2', 'triple1', 'triple', 'pair', 'single',
];

function groupByRank(cards: readonly Card[]): Map<number, Card[]> {
  const m = new Map<number, Card[]>();
  for (const c of cards) {
    const r = ddzRank(c);
    const g = m.get(r);
    if (g) g.push(c); else m.set(r, [c]);
  }
  return m;
}

/**
 * 这些牌能算哪些牌型（可能不止一种，比如 333444555666 是四连飞机，也是三连飞机带三张单）。
 * 按首出的优先顺序排好，不成牌型返回空数组。
 */
export function classifyDdz(cards: readonly Card[]): DdzCombo[] {
  const n = cards.length;
  if (n === 0) return [];
  const groups = groupByRank(cards);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const cnt = (r: number) => groups.get(r)?.length ?? 0;
  const out: DdzCombo[] = [];
  const add = (type: DdzComboType, rank: number, length: number) => out.push({ type, rank, length, cards });

  if (n === 2 && ranks.length === 2 && ranks[0] === 16 && ranks[1] === 17) {
    add('rocket', 17, 1);
    return out;
  }
  if (ranks.length === 1) {
    const r = ranks[0] as number;
    if (n === 1) add('single', r, 1);
    else if (n === 2) add('pair', r, 1);
    else if (n === 3) add('triple', r, 1);
    else if (n === 4) add('bomb', r, 1);
    return out;
  }
  if (n === 4) {
    const t = ranks.find((r) => cnt(r) === 3);
    if (t !== undefined) add('triple1', t, 1);
  }
  if (n === 5 && ranks.length === 2) {
    const t = ranks.find((r) => cnt(r) === 3);
    const p = ranks.find((r) => cnt(r) === 2);
    if (t !== undefined && p !== undefined) add('triple2', t, 1);
  }
  const top = ranks[ranks.length - 1] as number;
  const consecutive = top <= CHAIN_MAX && ranks.every((r, i) => i === 0 || r === (ranks[i - 1] as number) + 1);
  if (consecutive) {
    const L = ranks.length;
    if (L >= 5 && ranks.every((r) => cnt(r) === 1)) add('straight', top, L);
    if (L >= 3 && ranks.every((r) => cnt(r) === 2)) add('pairStraight', top, L);
    if (L >= 2 && ranks.every((r) => cnt(r) === 3)) add('plane', top, L);
  }
  for (const r of ranks) {
    if (cnt(r) !== 4) continue;
    if (n === 6) add('four2', r, 1);
    if (n === 8 && ranks.every((x) => x === r || cnt(x) % 2 === 0)) add('four22', r, 1);
  }
  // 飞机带翅膀：连着的三张（到 A 为止），每个三张带一张单或一对
  const trip = ranks.filter((r) => cnt(r) >= 3 && r <= CHAIN_MAX);
  for (const hi of trip) {
    for (let k = 2; trip.includes(hi - k + 1); k++) {
      const run = new Set(Array.from({ length: k }, (_, i) => hi - i));
      if (n === 4 * k) add('plane1', hi, k);
      if (n === 5 * k) {
        // 剩下的 2k 张要正好是 k 对
        const rest = ranks.map((r) => cnt(r) - (run.has(r) ? 3 : 0)).filter((c) => c > 0);
        if (rest.every((c) => c % 2 === 0) && rest.reduce((a, c) => a + c / 2, 0) === k) add('plane2', hi, k);
      }
    }
  }
  return out.sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type) || b.length - a.length || b.rank - a.rank);
}

/** c 能不能管住 lead */
export function ddzBeats(c: DdzCombo, lead: DdzCombo): boolean {
  if (lead.type === 'rocket') return false;
  if (c.type === 'rocket') return true;
  if (c.type === 'bomb') return lead.type !== 'bomb' || c.rank > lead.rank;
  if (lead.type === 'bomb') return false;
  return c.type === lead.type && c.length === lead.length && c.cards.length === lead.cards.length && c.rank > lead.rank;
}

/**
 * 打出 cards 时按哪种牌型算：首出（lead 为 null）按优先顺序取第一种；跟牌取能管住上家的那一种。
 * 不成牌型或管不住返回 null。
 */
export function ddzComboFor(cards: readonly Card[], lead: DdzCombo | null): DdzCombo | null {
  const all = classifyDdz(cards);
  if (!lead) return all[0] ?? null;
  return all.find((c) => ddzBeats(c, lead)) ?? null;
}

/** 手牌按点数从大到小、同点数按花色排好 */
export function sortDdzHand(cards: readonly Card[]): Card[] {
  const suitOrder = { J: 0, S: 1, H: 2, C: 3, D: 4 } as const;
  return [...cards].sort((a, b) => ddzRank(b) - ddzRank(a) || suitOrder[a.suit] - suitOrder[b.suit]);
}

/** 带牌：从不在 exclude 里的点数中挑最小的 k 张单牌（先挑单张，再拆对子、三张，最后才拆炸弹） */
function smallestSingles(groups: Map<number, Card[]>, exclude: ReadonlySet<number>, k: number): Card[] | null {
  const ranks = [...groups.keys()].filter((r) => !exclude.has(r));
  const order = [1, 2, 3, 4].flatMap((size) => ranks.filter((r) => (groups.get(r) as Card[]).length === size).sort((a, b) => a - b));
  const out: Card[] = [];
  for (const r of order) {
    for (const c of groups.get(r) as Card[]) {
      if (out.length === k) return out;
      out.push(c);
    }
  }
  return out.length === k ? out : null;
}

/** 带牌：从不在 exclude 里的点数中挑最小的 k 对（先挑对子，再拆三张，最后才拆炸弹），每对点数不同 */
function smallestPairs(groups: Map<number, Card[]>, exclude: ReadonlySet<number>, k: number): Card[] | null {
  const ranks = [...groups.keys()].filter((r) => !exclude.has(r) && (groups.get(r) as Card[]).length >= 2);
  const order = [2, 3, 4].flatMap((size) => ranks.filter((r) => (groups.get(r) as Card[]).length === size).sort((a, b) => a - b));
  if (order.length < k) return null;
  return order.slice(0, k).flatMap((r) => (groups.get(r) as Card[]).slice(0, 2));
}

/** 从 lo 到 hi 每个点数各取 per 张；有一个不够就返回 null */
function takeRun(groups: Map<number, Card[]>, hi: number, length: number, per: number): Card[] | null {
  const out: Card[] = [];
  for (let r = hi - length + 1; r <= hi; r++) {
    const g = groups.get(r);
    if (!g || g.length < per) return null;
    out.push(...g.slice(0, per));
  }
  return out;
}

function make(type: DdzComboType, rank: number, length: number, cards: readonly Card[]): DdzCombo {
  return { type, rank, length, cards };
}

/**
 * 手里所有能出的、某一种牌型和长度的出法（每个点数一种，带牌挑最小的），点数从小到大。
 * minRank 以上（不含）才算。
 */
function optionsOfType(groups: Map<number, Card[]>, type: DdzComboType, length: number, minRank: number): DdzCombo[] {
  const out: DdzCombo[] = [];
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const cnt = (r: number) => groups.get(r)?.length ?? 0;
  const first = (r: number, k: number) => (groups.get(r) as Card[]).slice(0, k);
  switch (type) {
    case 'single': for (const r of ranks) if (r > minRank) out.push(make(type, r, 1, first(r, 1))); break;
    case 'pair': for (const r of ranks) if (r > minRank && cnt(r) >= 2) out.push(make(type, r, 1, first(r, 2))); break;
    case 'triple': for (const r of ranks) if (r > minRank && cnt(r) >= 3) out.push(make(type, r, 1, first(r, 3))); break;
    case 'triple1':
    case 'triple2':
      for (const r of ranks) {
        if (r <= minRank || cnt(r) < 3) continue;
        const wings = type === 'triple1' ? smallestSingles(groups, new Set([r]), 1) : smallestPairs(groups, new Set([r]), 1);
        if (wings) out.push(make(type, r, 1, [...first(r, 3), ...wings]));
      }
      break;
    case 'straight':
    case 'pairStraight':
    case 'plane':
    case 'plane1':
    case 'plane2': {
      const per = type === 'straight' ? 1 : type === 'pairStraight' ? 2 : 3;
      for (let hi = Math.max(minRank + 1, 3 + length - 1); hi <= CHAIN_MAX; hi++) {
        const body = takeRun(groups, hi, length, per);
        if (!body) continue;
        if (type === 'plane1' || type === 'plane2') {
          const run = new Set(Array.from({ length }, (_, i) => hi - i));
          const wings = type === 'plane1' ? smallestSingles(groups, run, length) : smallestPairs(groups, run, length);
          if (wings) out.push(make(type, hi, length, [...body, ...wings]));
        } else {
          out.push(make(type, hi, length, body));
        }
      }
      break;
    }
    case 'four2':
    case 'four22':
      for (const r of ranks) {
        if (r <= minRank || cnt(r) < 4) continue;
        const wings = type === 'four2' ? smallestSingles(groups, new Set([r]), 2) : smallestPairs(groups, new Set([r]), 2);
        if (wings) out.push(make(type, r, 1, [...first(r, 4), ...wings]));
      }
      break;
    case 'bomb': for (const r of ranks) if (r > minRank && cnt(r) === 4) out.push(make(type, r, 1, first(r, 4))); break;
    case 'rocket': if (cnt(16) && cnt(17)) out.push(make(type, 17, 1, [...first(16, 1), ...first(17, 1)])); break;
  }
  return out;
}

/**
 * 跟牌时手里所有能管住 lead 的出法：同牌型从小到大，然后是炸弹从小到大，最后王炸。
 * 「提示」按这个顺序轮流给，机器人也从这里挑。
 */
export function ddzFollowOptions(hand: readonly Card[], lead: DdzCombo): DdzCombo[] {
  if (lead.type === 'rocket') return [];
  const groups = groupByRank(hand);
  const out: DdzCombo[] = [];
  if (lead.type !== 'bomb') out.push(...optionsOfType(groups, lead.type, lead.length, lead.rank));
  out.push(...optionsOfType(groups, 'bomb', 1, lead.type === 'bomb' ? lead.rank : 0));
  out.push(...optionsOfType(groups, 'rocket', 1, 0));
  return out;
}

/** 首出时某种牌型的所有出法（机器人和提示用） */
export function ddzOptionsOfType(hand: readonly Card[], type: DdzComboType, length: number): DdzCombo[] {
  return optionsOfType(groupByRank(hand), type, length, 0);
}
