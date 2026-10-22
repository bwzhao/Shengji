/**
 * 搜索机器人（第三版）：确定化蒙特卡洛。
 * 别人的手牌不知道，但知道约束：谁在哪个花色断门、每张牌还剩几张、亮出的牌在谁手里、庄家知道底牌。
 * 按约束随机补全全桌手牌，对每个候选出法用策略机器人把这局推演完，取平均收益最好的。
 * 同一份采样用于全部候选（共同随机数），降低方差。带时间预算。
 */
import { type Card, type Suit } from './cards.ts';
import { applyAction, ctxOf, currentTurn } from './reducer.ts';
import { createRng, type Rng } from './rng.ts';
import { candidatePlays, knownVoids, rankedBottomSets, rankedFriendCallSets, smartAction, type PlayCandidate } from './smartbot.ts';
import type { FriendCallSpec } from './state.ts';
import type { Action, GameState, Seat } from './state.ts';
import { groupOf, type Group } from './trump.ts';
import { exactMaxCards, exactValueAfterPlay, terminalUtility } from './endgame.ts';
import { beliefLoc, beliefProbs, canonIndex, hiddenInfo, suitSlots } from './belief.ts';
import { hasValueModel, predictUtility } from './valuenet.ts';

// 引擎不依赖 DOM 或 Node 类型，这里只声明用到的两个全局
declare const setTimeout: (fn: () => void, ms: number) => unknown;
const now = (): number => Date.now();

export interface SearchOptions {
  /** 时间预算，毫秒；到点就停，至少跑 minSamples 次采样 */
  readonly timeBudgetMs: number;
  readonly minSamples: number;
  readonly maxSamples: number;
  /** 最多评估多少个候选（按规则打分取前几） */
  readonly maxCandidates: number;
}

/** 采样先验的参数，模拟器可用 --tune 改动做 A/B */
export const searchTuning = {
  /** 1 开 0 关 */
  priors: 1,
  /** 实测（对真实暗牌的主牌数误差）：无先验 1.01 张，这组 0.85 张 */
  dealerTrumpPrior: 3.0,
  declarerTrumpPrior: 1.6,
  trumpLeaderPrior: 2.5,
  /** 手牌推断网络（1 开 0 关）；只在装入了对应人数的模型时生效 */
  belief: 1,
  /** 完美信息价值网络（1 开 0 关）；只在装入了对应人数的模型、且阵营已知（四人对家）时生效 */
  value: 1,
  /** 推演至少打完这么多墩之后，在下一墩开始时交给价值网络估值 */
  valueDepth: 1,
  /** 每人还剩这么多张以内时不截断，推演到底（最后几墩便宜又关键） */
  valueMinCards: 4,
};

/**
 * 推演截断：在一墩刚开始时，如果已经从起点打完了至少 valueDepth 墩、牌还多，就用价值网络估这一局的收益。
 * 返回 null 表示继续推演。
 */
function valueCut(s: GameState, seat: Seat, startTricks: number): number | null {
  if (searchTuning.value <= 0 || s.config.friendCount !== 0) return null;
  if (s.phase !== 'playing' || !s.trick || s.trick.plays.length > 0) return null;
  if (s.tricks.length - startTricks < searchTuning.valueDepth) return null;
  if ((s.hands[seat]?.length ?? 0) <= searchTuning.valueMinCards) return null;
  return predictUtility(s, seat);
}

export const defaultSearchOptions: SearchOptions = { timeBudgetMs: 600, minSamples: 4, maxSamples: 48, maxCandidates: 10 };

/**
 * 四人对家模式的推演更短、阵营全知，同样时间能多跑采样，候选也放宽；
 * 五六人沿用传入的参数。服务端按时间预算搜索时用；模拟器按固定采样数对比时不用，保证公平。
 */
export function tuneForMode(s: GameState, opts: SearchOptions): SearchOptions {
  if (s.config.players !== 4) return opts;
  // 有价值网络时每次采样便宜十几倍，采样上限放开，让时间预算决定采多少
  const valueOn = searchTuning.value > 0 && hasValueModel(4);
  const maxSamples = valueOn ? Math.max(opts.maxSamples, 2000) : Math.round(opts.maxSamples * 1.5);
  return { ...opts, maxSamples, maxCandidates: Math.max(opts.maxCandidates, 12) };
}

export interface SearchResult {
  readonly action: Action;
  readonly samples: number;
  readonly candidates: number;
  readonly elapsedMs: number;
  /** 每个候选的平均收益，与 candidates 顺序一致 */
  readonly means: readonly number[];
}

// ---------- 采样：按约束补全别人的手牌 ----------

interface Determinization {
  hands: Card[][];
  bottom: Card[];
}

/**
 * 生成一份与我方视角一致的全桌手牌。失败（约束冲突）时最多重试若干次，再退回忽略断门约束。
 */
export function sampleDeterminization(s: GameState, seat: Seat, rng: Rng): Determinization {
  const n = s.config.players;
  const ctx = ctxOf(s);
  const myHand = s.hands[seat] ?? [];
  const info = hiddenInfo(s, seat);
  const { pool, capacity, bottomCap, bottomKnown, revealed, voids } = info;
  // 手牌推断网络：有模型且开关打开时，用它给每张牌在每个位置的概率代替均匀分配和手写先验
  const probs = searchTuning.belief > 0 ? beliefProbs(s, seat, info) : null;
  const slots = probs ? suitSlots(s.trumpSuit) : null;

  // 按公开信息给各家加先验权重。庄家扣底留主，主牌偏向庄家；亮主的人主多；
  // 主动领过主的人主多。权重只改变采样分布，不排除任何可能。
  const trumpPrior: number[] = Array.from({ length: n }, () => 1);
  // 只在四人对家模式用：五六人三副牌实测这些先验反而让误差变大（1.13 张 → 1.17 到 1.47 张），
  // 领过副牌的人那门更长的先验也测过，效果在噪声内，都不用。
  if (!probs && searchTuning.priors > 0 && s.config.friendCount === 0) {
    if (s.dealer !== null && s.dealer !== seat) trumpPrior[s.dealer] = searchTuning.dealerTrumpPrior;
    if (s.declaration && s.declaration.seat !== seat) trumpPrior[s.declaration.seat] = Math.max(trumpPrior[s.declaration.seat] as number, searchTuning.declarerTrumpPrior);
    for (const t of s.tricks) {
      const first = t.plays[0];
      if (!first || t.leader === seat) continue;
      if (first.cards.every((c) => groupOf(c, ctx) === 'T')) trumpPrior[t.leader] = Math.max(trumpPrior[t.leader] as number, searchTuning.trumpLeaderPrior);
    }
  }

  const attempt = (respectVoids: boolean): Determinization | null => {
    const cap = [...capacity];
    let bcap = bottomCap;
    const hands: Card[][] = Array.from({ length: n }, (_, i) => (i === seat ? [...myHand] : [...(revealed.get(i) ?? [])]));
    const bottom: Card[] = bottomKnown ? [...s.bottom] : [];
    // 先放约束最紧的牌：断门的组越多越先分
    const shuffled = rng.shuffle(pool);
    const constrained = respectVoids
      ? shuffled.map((c) => ({ c, g: groupOf(c, ctx) })).sort((a, b) => voidCount(voids, b.g, n, seat) - voidCount(voids, a.g, n, seat))
      : shuffled.map((c) => ({ c, g: groupOf(c, ctx) }));
    for (const { c, g } of constrained) {
      const eligible: number[] = [];
      let total = 0;
      // 有网络时：剩余容量 × 网络给的概率 ÷ 初始容量。网络给出均匀概率时退化为原来的按容量分配
      const ci = probs ? canonIndex(c, slots as Suit[]) * n : 0;
      const weightOf = probs
        ? (i: number) => (cap[i]! * Math.max(1e-4, probs[ci + beliefLoc(i, seat, n)] as number)) / Math.max(1, capacity[i]!)
        : (i: number) => cap[i]! * (g === 'T' ? (trumpPrior[i] as number) : 1);
      for (let i = 0; i < n; i++) {
        if (cap[i]! <= 0) continue;
        if (respectVoids && voids.get(i)?.has(g)) continue;
        eligible.push(i);
        total += weightOf(i);
      }
      let bottomWeight = 0;
      if (bcap > 0) {
        eligible.push(-1);
        bottomWeight = probs ? (bcap * Math.max(1e-4, probs[ci + n - 1] as number)) / Math.max(1, bottomCap) : bcap * bottomBias(c, g);
        total += bottomWeight;
      }
      if (eligible.length === 0) return null;
      // 按剩余容量加权随机；主牌再乘各家的先验；底牌按「庄家会不会扣这张」再加权
      let r = rng.next() * total;
      let chosen = eligible[eligible.length - 1] as number;
      for (const i of eligible) {
        const w = i === -1 ? bottomWeight : weightOf(i);
        if (r < w) { chosen = i; break; }
        r -= w;
      }
      if (chosen === -1) { bottom.push(c); bcap--; }
      else { hands[chosen]!.push(c); cap[chosen]!--; }
    }
    return { hands, bottom };
  };

  for (let i = 0; i < 12; i++) {
    const d = attempt(true);
    if (d) return d;
  }
  return attempt(false) as Determinization;
}

/** 庄家扣底偏好：主牌几乎不扣，分牌很少扣，副牌小牌最常扣 */
function bottomBias(c: Card, g: Group): number {
  if (g === 'T') return 0.15;
  const pts = c.rank === 5 || c.rank === 10 || c.rank === 13;
  if (pts) return 0.35;
  if (c.rank >= 12) return 0.5;
  return 2.2;
}

function voidCount(voids: Map<Seat, Set<Group>>, g: Group, n: number, me: Seat): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (i !== me && voids.get(i)?.has(g)) k++;
  return k;
}

// ---------- 推演 ----------

/** 从 seat 出 cards 开始，用策略机器人把这局打完，返回从 seat 角度看的收益（单位：一级） */
function rollout(base: GameState, seat: Seat, cards: Card[], det: Determinization, rng: Rng): number | null {
  let s: GameState = { ...base, hands: det.hands, bottom: det.bottom };
  // 残局：能精确算就精确算
  if ((s.hands[seat]?.length ?? 0) <= exactMaxCards(s)) {
    const exact = exactValueAfterPlay(s, seat, cards);
    if (exact !== null) return exact;
  }
  const startTricks = s.tricks.length;
  const first = applyAction(s, { type: 'play', seat, cards: cards.map((c) => c.id) });
  if (!first.ok) return null;
  s = first.state;
  let guard = 0;
  while (s.phase === 'playing') {
    if (++guard > 400) return null;
    const cut = valueCut(s, seat, startTricks);
    if (cut !== null) return cut;
    const turn = currentTurn(s);
    if (turn === null) return null;
    const a = smartAction(s, turn, rng, 2);
    if (!a) return null;
    const r = applyAction(s, a);
    if (!r.ok) return null;
    s = r.state;
  }
  const res = s.lastRound;
  if (!res) return null;
  return terminalUtility(res, seat, s.config.levelStep);
}

// ---------- 批量采样：可在任意线程运行的纯函数 ----------

/** 评估「seat 在确定化局面上执行 action」的收益：出牌残局走精确求解，其余用二版机器人打完 */
export function evaluateAction(base: GameState, seat: Seat, action: Action, det: Determinization, rng: Rng): number | null {
  const s: GameState = { ...base, hands: det.hands, bottom: det.bottom };
  if (action.type === 'play' && (s.hands[seat]?.length ?? 0) <= exactMaxCards(s)) {
    const cards = (s.hands[seat] ?? []).filter((c) => action.cards.includes(c.id));
    const exact = exactValueAfterPlay(s, seat, cards);
    if (exact !== null) return exact;
  }
  const r = applyAction(s, action);
  if (!r.ok) return null;
  return playoutFrom(r.state, seat, rng, s.tricks.length);
}

export interface SearchBatchJob {
  readonly state: GameState;
  readonly seat: Seat;
  readonly actions: readonly Action[];
  /** 仍在比较中的候选下标 */
  readonly alive: readonly number[];
  /** 每个种子对应一次采样 */
  readonly seeds: readonly string[];
}

export interface SearchBatchResult {
  readonly sums: number[];
  readonly counts: number[];
  readonly samples: number;
}

/** 跑一批采样：每个种子生成一份手牌补全，用同一推演随机序列评估所有存活候选 */
export function runSearchBatch(job: SearchBatchJob): SearchBatchResult {
  const sums = new Array<number>(job.actions.length).fill(0);
  const counts = new Array<number>(job.actions.length).fill(0);
  for (const seed of job.seeds) {
    const rng = createRng(`det/${seed}`);
    const det = sampleDeterminization(job.state, job.seat, rng);
    for (const i of job.alive) {
      const u = evaluateAction(job.state, job.seat, job.actions[i] as Action, det, createRng(`roll/${seed}`));
      if (u === null) continue;
      sums[i]! += u;
      counts[i]! += 1;
    }
  }
  return { sums, counts, samples: job.seeds.length };
}

/** 逐轮淘汰：采样到 4、8、14 次时分别只保留前 5、3、2 名 */
export function pruneCandidates(alive: readonly number[], sums: readonly number[], counts: readonly number[], samples: number, tieBreak: readonly number[]): number[] {
  const keep = samples >= 14 ? 2 : samples >= 8 ? 3 : samples >= 4 ? 5 : Infinity;
  if (alive.length <= keep) return [...alive];
  const mean = (i: number) => (counts[i]! > 0 ? sums[i]! / counts[i]! : -Infinity);
  return [...alive].sort((a, b) => mean(b) - mean(a) || (tieBreak[b] ?? 0) - (tieBreak[a] ?? 0)).slice(0, keep);
}

export function chooseBest(alive: readonly number[], sums: readonly number[], counts: readonly number[], tieBreak: readonly number[]): number {
  const mean = (i: number) => (counts[i]! > 0 ? sums[i]! / counts[i]! : -Infinity);
  let best = alive[0] ?? 0;
  for (const i of alive) {
    const a = mean(i), b = mean(best);
    if (a > b + 1e-9 || (Math.abs(a - b) <= 1e-9 && (tieBreak[i] ?? 0) > (tieBreak[best] ?? 0))) best = i;
  }
  return best;
}

/** 出牌搜索的候选动作与规则打分 */
export function playCandidates(s: GameState, seat: Seat, rng: Rng, maxCandidates: number): { actions: Action[]; heuristics: number[] } {
  const all = candidatePlays(s, seat, rng, 2);
  // 庄家先找队友、有机会做庄家队友就做：真人的固定打法，不交给推演比较。多个候选都能成为队友时只在它们之间推演
  const forced = all.filter((c) => c.heuristic >= 999);
  const cands = forced.length > 0 ? forced.slice(0, Math.max(1, maxCandidates)) : all.slice(0, Math.max(1, maxCandidates));
  return {
    actions: cands.map((c) => ({ type: 'play', seat, cards: c.cards.map((x) => x.id) })),
    heuristics: cands.map((c) => c.heuristic),
  };
}

/** 扣底 / 叫朋友的候选动作 */
export function dealerCandidates(s: GameState, seat: Seat): Action[] {
  if (s.phase === 'bottom') return rankedBottomSets(s, seat, 6).map((cards) => ({ type: 'exchangeBottom', seat, cards: cards.map((c) => c.id) }));
  if (s.phase === 'callFriend') return rankedFriendCallSets(s, seat, 6).map((calls) => ({ type: 'callFriend', seat, calls }));
  return [];
}

// ---------- 搜索 ----------

interface SearchState {
  readonly cands: PlayCandidate[];
  readonly sums: number[];
  readonly counts: number[];
  /** 仍在比较中的候选下标 */
  alive: number[];
  samples: number;
  readonly t0: number;
}

function beginSearch(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions): SearchState {
  const all = candidatePlays(s, seat, rng, 2);
  const cands = all.slice(0, Math.max(1, opts.maxCandidates));
  return { cands, sums: new Array<number>(cands.length).fill(0), counts: new Array<number>(cands.length).fill(0), alive: cands.map((_, i) => i), samples: 0, t0: now() };
}

/** 跑一次采样：同一采样、同一推演随机序列，所有候选公平比较 */
function searchStep(s: GameState, seat: Seat, rng: Rng, st: SearchState): void {
  const det = sampleDeterminization(s, seat, rng);
  const seed = `${rng.next()}`;
  for (const i of st.alive) {
    const u = rollout(s, seat, (st.cands[i] as PlayCandidate).cards, det, createRng(seed));
    if (u === null) continue;
    st.sums[i]! += u;
    st.counts[i]! += 1;
  }
  st.samples++;
  prune(st);
}

/** 逐轮淘汰：采样到 4、8、14 次时分别只保留前 5、3、2 名，后面的预算全给它们 */
function prune(st: SearchState): void {
  const keep = st.samples >= 14 ? 2 : st.samples >= 8 ? 3 : st.samples >= 4 ? 5 : Infinity;
  if (st.alive.length <= keep) return;
  const mean = (i: number) => (st.counts[i]! > 0 ? st.sums[i]! / st.counts[i]! : -Infinity);
  st.alive = [...st.alive].sort((a, b) => mean(b) - mean(a) || (st.cands[b] as PlayCandidate).heuristic - (st.cands[a] as PlayCandidate).heuristic).slice(0, keep);
}

function shouldContinue(st: SearchState, opts: SearchOptions): boolean {
  if (st.samples >= opts.maxSamples) return false;
  if (st.samples < opts.minSamples) return true;
  return now() - st.t0 <= opts.timeBudgetMs;
}

function finishSearch(seat: Seat, st: SearchState): SearchResult {
  const { cands, sums, counts } = st;
  const means = cands.map((_, i) => (counts[i]! > 0 ? sums[i]! / counts[i]! : -Infinity));
  let best = st.alive[0] ?? 0;
  for (const i of st.alive) {
    const a = means[i]!, b = means[best]!;
    if (a > b + 1e-9 || (Math.abs(a - b) <= 1e-9 && (cands[i] as PlayCandidate).heuristic > (cands[best] as PlayCandidate).heuristic)) best = i;
  }
  const chosen = (means[best] === -Infinity ? cands[0] : cands[best]) as PlayCandidate;
  return {
    action: { type: 'play', seat, cards: chosen.cards.map((c) => c.id) },
    samples: st.samples,
    candidates: cands.length,
    elapsedMs: now() - st.t0,
    means,
  };
}

function trivial(s: GameState, seat: Seat, st: SearchState): boolean {
  return st.cands.length === 1 || (s.hands[seat]?.length ?? 0) <= 1;
}

/** 同步搜索：模拟器用 */
export function searchPlay(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions = defaultSearchOptions): SearchResult {
  const st = beginSearch(s, seat, rng, opts);
  if (!trivial(s, seat, st)) while (shouldContinue(st, opts)) searchStep(s, seat, rng, st);
  return finishSearch(seat, st);
}

/** 异步搜索：每次采样之间让出事件循环，服务端用，不会卡住收发消息 */
export async function searchPlayAsync(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions = defaultSearchOptions): Promise<SearchResult> {
  const st = beginSearch(s, seat, rng, opts);
  if (!trivial(s, seat, st)) {
    while (shouldContinue(st, opts)) {
      searchStep(s, seat, rng, st);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  return finishSearch(seat, st);
}

// ---------- 庄家决策：扣底与叫朋友也用推演 ----------

/** 从任意阶段把这局用二版机器人打到结束，返回 seat 角度收益 */
function playoutFrom(start: GameState, seat: Seat, rng: Rng, startTricks = start.tricks.length): number | null {
  let s = start;
  let guard = 0;
  while (s.phase !== 'roundEnd' && s.phase !== 'gameOver') {
    if (++guard > 500) return null;
    const cut = valueCut(s, seat, startTricks);
    if (cut !== null) return cut;
    // 扣底、四人抄底、叫朋友、出牌都按轮到谁来
    const actor = currentTurn(s);
    if (actor === null) return null;
    const a = smartAction(s, actor, rng, 2);
    if (!a) return null;
    const r = applyAction(s, a);
    if (!r.ok) return null;
    s = r.state;
  }
  return s.lastRound ? terminalUtility(s.lastRound, seat, s.config.levelStep) : null;
}

/** 对一组「候选动作」做同样的采样推演比较，返回最好的一个 */
async function compareActions(
  s: GameState, seat: Seat, rng: Rng, opts: SearchOptions, actions: Action[], yieldBetween: boolean,
): Promise<{ index: number; samples: number; means: number[] }> {
  const sums = new Array<number>(actions.length).fill(0);
  const counts = new Array<number>(actions.length).fill(0);
  let alive = actions.map((_, i) => i);
  let samples = 0;
  const t0 = now();
  while (samples < opts.maxSamples && (samples < opts.minSamples || now() - t0 <= opts.timeBudgetMs)) {
    const det = sampleDeterminization(s, seat, rng);
    const base: GameState = { ...s, hands: det.hands, bottom: det.bottom };
    const seed = `${rng.next()}`;
    for (const i of alive) {
      const r = applyAction(base, actions[i] as Action);
      if (!r.ok) continue;
      const u = playoutFrom(r.state, seat, createRng(seed));
      if (u === null) continue;
      sums[i]! += u; counts[i]! += 1;
    }
    samples++;
    const keep = samples >= 12 ? 2 : samples >= 6 ? 3 : Infinity;
    if (alive.length > keep) {
      const mean = (i: number) => (counts[i]! > 0 ? sums[i]! / counts[i]! : -Infinity);
      alive = [...alive].sort((a, b) => mean(b) - mean(a)).slice(0, keep);
    }
    if (yieldBetween) await new Promise<void>((r) => setTimeout(r, 0));
  }
  const means = actions.map((_, i) => (counts[i]! > 0 ? sums[i]! / counts[i]! : -Infinity));
  let best = alive[0] ?? 0;
  for (const i of alive) if (means[i]! > means[best]!) best = i;
  return { index: best, samples, means };
}

/** 扣底：在第二版首选的基础上比较几组变体 */
export async function searchExchangeBottomAsync(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions, yieldBetween = true): Promise<Action> {
  const sets = rankedBottomSets(s, seat, 6);
  const actions: Action[] = sets.map((cards) => ({ type: 'exchangeBottom', seat, cards: cards.map((c) => c.id) }));
  if (actions.length === 1) return actions[0] as Action;
  const r = await compareActions(s, seat, rng, opts, actions, yieldBetween);
  return actions[r.index] as Action;
}

/** 叫朋友：比较几组候选叫法 */
export async function searchCallFriendAsync(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions, yieldBetween = true): Promise<Action> {
  const sets: FriendCallSpec[][] = rankedFriendCallSets(s, seat, 6);
  const actions: Action[] = sets.map((calls) => ({ type: 'callFriend', seat, calls }));
  if (actions.length === 1) return actions[0] as Action;
  const r = await compareActions(s, seat, rng, opts, actions, yieldBetween);
  return actions[r.index] as Action;
}

/** 第三版机器人：出牌用搜索，其余沿用第二版 */
export function searchAction(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions = defaultSearchOptions): Action | null {
  if (s.phase === 'playing') return currentTurn(s) === seat ? searchPlay(s, seat, rng, opts).action : null;
  return smartAction(s, seat, rng, 2);
}
