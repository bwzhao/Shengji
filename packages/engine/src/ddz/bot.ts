/**
 * 斗地主机器人：把手牌拆成尽量少的几手（王炸、炸弹、飞机、顺子、连对、三张带牌、对子、单张），
 * 首出先走小的，跟牌只在不打乱手牌或对手快走完时才管，队友的牌不管，炸弹留到要紧时用。
 * 只用座位上看得到的信息（自己的手牌、各人剩几张、谁是地主、上一手），所以「提示」也能用。
 */
import { removeCards, type Card } from '../cards.ts';
import type { Seat } from '../state.ts';
import { classifyDdz, ddzComboFor, ddzFollowOptions, ddzRank, type DdzCombo, type DdzComboType, type DdzPlayers } from './combos.ts';
import { ddzPlayers, type DdzAction, type DdzState, type DdzView } from './game.ts';

/** 机器人做决定要看的信息：服务端用 DdzState，提示用 DdzView */
export interface DdzBotContext {
  readonly players: DdzPlayers;
  readonly seat: Seat;
  readonly hand: readonly Card[];
  readonly handCounts: readonly number[];
  readonly landlord: Seat | null;
  readonly lastPlay: { readonly seat: Seat; readonly combo: DdzCombo } | null;
}

export function ddzContextOf(s: DdzState, seat: Seat): DdzBotContext {
  return { players: ddzPlayers(s), seat, hand: s.hands[seat] ?? [], handCounts: s.hands.map((h) => h.length), landlord: s.landlord, lastPlay: s.lastPlay };
}

export function ddzContextOfView(v: DdzView): DdzBotContext {
  return { players: v.players ?? 3, seat: v.seat, hand: v.hand, handCounts: v.handCounts, landlord: v.landlord, lastPlay: v.lastPlay };
}

const CHAIN_MAX = 14;

function counts(hand: readonly Card[]): Map<number, Card[]> {
  const m = new Map<number, Card[]>();
  for (const c of hand) {
    const r = ddzRank(c);
    const g = m.get(r);
    if (g) g.push(c); else m.set(r, [c]);
  }
  return m;
}

function take(m: Map<number, Card[]>, r: number, k: number): Card[] {
  const g = m.get(r) as Card[];
  const out = g.splice(0, k);
  if (g.length === 0) m.delete(r);
  return out;
}

const n = (m: Map<number, Card[]>, r: number) => m.get(r)?.length ?? 0;

function combo(type: DdzComboType, rank: number, length: number, cards: readonly Card[]): DdzCombo {
  return { type, rank, length, cards };
}

/** 拆顺子的方式：先拆顺子、只用不成对的牌拆顺子、不拆顺子 */
type StraightMode = 'all' | 'loose' | 'none';

/** 按一种拆法把手牌拆成几手，带牌也配好。四人：炸弹可以多到 8 张，王炸要四个王，三张和飞机只能带对子 */
function planWith(hand: readonly Card[], mode: StraightMode, players: DdzPlayers): DdzCombo[] {
  const four = players === 4;
  const m = counts(hand);
  const out: DdzCombo[] = [];
  const jokers = four ? 2 : 1;
  if (n(m, 16) >= jokers && n(m, 17) >= jokers) out.push(combo('rocket', 17, 1, [...take(m, 16, jokers), ...take(m, 17, jokers)]));
  for (const r of [...m.keys()]) {
    const k = n(m, r);
    if (r < 16 && (k === 4 || (four && k > 4))) out.push(combo('bomb', r, k, take(m, r, k)));
  }
  // 飞机：连着的三张
  const planes: DdzCombo[] = [];
  for (let lo = 3; lo <= CHAIN_MAX; lo++) {
    let hi = lo;
    while (hi + 1 <= CHAIN_MAX && n(m, hi + 1) >= 3 && n(m, lo) >= 3) hi++;
    if (n(m, lo) >= 3 && hi > lo) {
      const cards: Card[] = [];
      for (let r = lo; r <= hi; r++) cards.push(...take(m, r, 3));
      planes.push(combo('plane', hi, hi - lo + 1, cards));
      lo = hi;
    }
  }
  // 顺子：从最小的点数起找 5 张连着的，能长就长
  const straights: DdzCombo[] = [];
  if (mode !== 'none') {
    const usable = (r: number) => n(m, r) >= 1 && (mode === 'all' || n(m, r) === 1);
    for (let lo = 3; lo + 4 <= CHAIN_MAX;) {
      let ok = true;
      for (let r = lo; r < lo + 5; r++) if (!usable(r)) { ok = false; break; }
      if (!ok) { lo++; continue; }
      let hi = lo + 4;
      while (hi + 1 <= CHAIN_MAX && usable(hi + 1)) hi++;
      const cards: Card[] = [];
      for (let r = lo; r <= hi; r++) cards.push(...take(m, r, 1));
      straights.push(combo('straight', hi, hi - lo + 1, cards));
    }
  }
  // 连对
  const pairChains: DdzCombo[] = [];
  for (let lo = 3; lo + 2 <= CHAIN_MAX;) {
    if (!(n(m, lo) === 2 && n(m, lo + 1) === 2 && n(m, lo + 2) === 2)) { lo++; continue; }
    let hi = lo + 2;
    while (hi + 1 <= CHAIN_MAX && n(m, hi + 1) === 2) hi++;
    const cards: Card[] = [];
    for (let r = lo; r <= hi; r++) cards.push(...take(m, r, 2));
    pairChains.push(combo('pairStraight', hi, hi - lo + 1, cards));
    lo = hi + 1;
  }
  const triples: number[] = [];
  const pairs: number[] = [];
  const singles: number[] = [];
  for (const r of [...m.keys()].sort((a, b) => a - b)) {
    const k = n(m, r);
    if (k === 3) triples.push(r);
    else if (k === 2) pairs.push(r);
    else if (k === 1) singles.push(r);
  }
  // 带牌：三张、飞机先带小单张，再带小对子（2 和王不带出去）
  const smallSingles = singles.filter((r) => r <= CHAIN_MAX);
  const smallPairs = pairs.filter((r) => r <= 13);
  for (const p of planes) {
    const k = p.length;
    if (!four && smallSingles.length >= k) {
      const wings = smallSingles.splice(0, k);
      singles.splice(0, singles.length, ...singles.filter((r) => !wings.includes(r)));
      out.push(combo('plane1', p.rank, k, [...p.cards, ...wings.flatMap((r) => take(m, r, 1))]));
    } else if (smallPairs.length >= k) {
      const wings = smallPairs.splice(0, k);
      pairs.splice(0, pairs.length, ...pairs.filter((r) => !wings.includes(r)));
      out.push(combo('plane2', p.rank, k, [...p.cards, ...wings.flatMap((r) => take(m, r, 2))]));
    } else {
      out.push(p);
    }
  }
  for (const t of triples) {
    const body = take(m, t, 3);
    if (!four && smallSingles.length > 0) {
      const w = smallSingles.shift() as number;
      singles.splice(singles.indexOf(w), 1);
      out.push(combo('triple1', t, 1, [...body, ...take(m, w, 1)]));
    } else if (smallPairs.length > 0) {
      const w = smallPairs.shift() as number;
      pairs.splice(pairs.indexOf(w), 1);
      out.push(combo('triple2', t, 1, [...body, ...take(m, w, 2)]));
    } else {
      out.push(combo('triple', t, 1, body));
    }
  }
  out.push(...straights, ...pairChains);
  for (const r of pairs) out.push(combo('pair', r, 1, take(m, r, 2)));
  for (const r of singles) out.push(combo('single', r, 1, take(m, r, 1)));
  return out;
}

/** 一种拆法的好坏：手数越少越好，小单张越少越好 */
function planCost(groups: readonly DdzCombo[]): number {
  let cost = groups.length * 10;
  for (const g of groups) if (g.type === 'single' && g.rank < 11) cost += 1;
  return cost;
}

/** 把手牌拆成最少的几手 */
export function planDdzHand(hand: readonly Card[], players: DdzPlayers = 3): DdzCombo[] {
  let best: DdzCombo[] | null = null;
  for (const mode of ['all', 'loose', 'none'] as const) {
    const p = planWith(hand, mode, players);
    if (!best || planCost(p) < planCost(best)) best = p;
  }
  return best as DdzCombo[];
}

const isBomb = (c: DdzCombo) => c.type === 'bomb' || c.type === 'rocket';

/** 牌力分：王、2、炸弹、A 越多分越高，手数越少分越高 */
export function ddzHandScore(hand: readonly Card[], players: DdzPlayers = 3): number {
  const m = counts(hand);
  let score = 0;
  if (players === 4) {
    if (n(m, 16) >= 2 && n(m, 17) >= 2) score += 14;
    else score += n(m, 17) * 4 + n(m, 16) * 3;
    score += n(m, 15) * 2 + n(m, 14);
    // 炸弹越长越值钱
    for (const [r, g] of m) if (g.length >= 4 && r < 16) score += 4 + (g.length - 4) * 3;
    return score + Math.max(0, 13 - planDdzHand(hand, 4).length);
  }
  if (n(m, 16) && n(m, 17)) score += 8;
  else score += n(m, 17) * 4 + n(m, 16) * 3;
  score += n(m, 15) * 2 + n(m, 14);
  for (const [r, g] of m) if (g.length === 4 && r < 16) score += 6;
  return score + Math.max(0, 9 - planDdzHand(hand).length);
}

/**
 * 叫几分的牌力线。三人约 40%、17%、3% 的手牌够叫 1、2、3 分；
 * 四人的线按随机发牌的分布（4000 局）定在同样的比例上
 */
const BID_LINES: Readonly<Record<DdzPlayers, readonly [number, number, number]>> = {
  3: [9, 12, 16],
  4: [19, 23, 28],
};

/** 叫分：牌力越强叫得越高；比现在的分高才叫，否则不叫 */
export function ddzBidPoints(hand: readonly Card[], current: number, players: DdzPlayers = 3): number {
  const score = ddzHandScore(hand, players);
  const [one, two, three] = BID_LINES[players];
  const want = score >= three ? 3 : score >= two ? 2 : score >= one ? 1 : 0;
  return want > current ? want : 0;
}

/** 对手里剩牌最少的那个还有几张 */
function enemyMin(ctx: DdzBotContext): number {
  const enemies = ctx.handCounts.map((_, i) => i).filter((i) => i !== ctx.seat && (ctx.seat === ctx.landlord || i === ctx.landlord));
  return Math.min(...enemies.map((i) => ctx.handCounts[i] as number));
}

/** 首出：能一手出完就出完；队友只剩一张就送小单；对手快走完时避开他能接的牌型；平时先走小的 */
function chooseLead(ctx: DdzBotContext): DdzCombo {
  const whole = ddzComboFor(ctx.hand, null, ctx.players);
  if (whole) return whole;
  const plan = planDdzHand(ctx.hand, ctx.players);
  const partners = ctx.landlord !== null && ctx.seat !== ctx.landlord ? ctx.handCounts.map((_, i) => i).filter((i) => i !== ctx.seat && i !== ctx.landlord) : [];
  const singles = plan.filter((g) => g.type === 'single').sort((a, b) => a.rank - b.rank);
  if (partners.some((p) => ctx.handCounts[p] === 1) && singles[0]) return singles[0];
  // 只剩两手、其中一手是炸弹：先出炸弹，再走最后一手
  const nonBombs = plan.filter((g) => !isBomb(g));
  if (nonBombs.length === 0) return plan.sort((a, b) => a.rank - b.rank)[0] as DdzCombo;
  if (nonBombs.length === 1 && plan.length === 2) return plan.find(isBomb) as DdzCombo;
  const danger = enemyMin(ctx);
  let pool = nonBombs;
  if (danger === 1) {
    const multi = pool.filter((g) => g.type !== 'single');
    // 都是单张：从大的出
    if (multi.length === 0) return pool.sort((a, b) => b.rank - a.rank)[0] as DdzCombo;
    pool = multi;
  } else if (danger === 2) {
    const notPair = pool.filter((g) => g.type !== 'pair');
    if (notPair.length > 0) pool = notPair;
  }
  // 先走小的；同样小的先走张数多的
  return [...pool].sort((a, b) => a.rank - b.rank || b.cards.length - a.cards.length)[0] as DdzCombo;
}

/** 跟牌：返回要出的牌型，null 是不出 */
function chooseFollow(ctx: DdzBotContext): DdzCombo | null {
  const last = ctx.lastPlay as { seat: Seat; combo: DdzCombo };
  const whole = ddzComboFor(ctx.hand, last.combo, ctx.players);
  if (whole) return whole;
  const options = ddzFollowOptions(ctx.hand, last.combo, ctx.players);
  if (options.length === 0) return null;
  // 队友的牌不管
  const teammate = ctx.landlord !== null && ctx.seat !== ctx.landlord && last.seat !== ctx.landlord;
  if (teammate) return null;
  const danger = enemyMin(ctx);
  const cur = planDdzHand(ctx.hand, ctx.players).length;
  const scored = options.map((o) => ({ o, after: planDdzHand(removeCards(ctx.hand, o.cards), ctx.players).length }));
  const plain = scored.filter((x) => !isBomb(x.o)).sort((a, b) => a.after - b.after || a.o.rank - b.o.rank);
  const best = plain[0];
  if (best) {
    // 正好是手里的一手，或者对手快走完了，就管；拆牌只拆不到 2 的
    const spendsTop = best.o.rank >= 15 && last.combo.rank < 11 && danger > 5;
    if (!spendsTop && (best.after < cur || (best.after === cur && best.o.rank <= CHAIN_MAX))) return best.o;
    if (danger <= 3) return best.o;
  }
  // 炸弹：对手快走完了，或者炸完自己也快走完了
  const bomb = scored.filter((x) => isBomb(x.o))[0];
  if (bomb && (danger <= 3 || bomb.after <= 1)) return bomb.o;
  return null;
}

/** 出牌：首出或跟牌，返回要出的牌型；null 是不出 */
export function ddzChoosePlay(ctx: DdzBotContext): DdzCombo | null {
  const free = !ctx.lastPlay || ctx.lastPlay.seat === ctx.seat;
  return free ? chooseLead(ctx) : chooseFollow(ctx);
}

/** 机器人在这个局面下要做的事；不该它动时返回 null */
export function ddzBotAction(s: DdzState, seat: Seat): DdzAction | null {
  if (s.turn !== seat) return null;
  if (s.phase === 'bidding') return { type: 'bid', seat, points: ddzBidPoints(s.hands[seat] ?? [], s.bid, ddzPlayers(s)) };
  if (s.phase !== 'playing') return null;
  const choice = ddzChoosePlay(ddzContextOf(s, seat));
  return choice ? { type: 'play', seat, cards: choice.cards.map((c) => c.id) } : { type: 'pass', seat };
}

/** 跟牌时还有没有能管住的牌（没有就自动「要不起」） */
export function ddzCanFollow(hand: readonly Card[], lead: DdzCombo, players: DdzPlayers = 3): boolean {
  return ddzFollowOptions(hand, lead, players).length > 0;
}

/** 这些牌是不是一个合法牌型（首出时用来点亮「出牌」按钮） */
export function ddzIsCombo(cards: readonly Card[], players: DdzPlayers = 3): boolean {
  return classifyDdz(cards, players).length > 0;
}
