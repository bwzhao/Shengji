/**
 * 带策略的机器人：不搜索，只用牌桌常识。
 * 亮主看牌力；扣底扣短门无分小牌；叫朋友叫自己缺门的 A；
 * 首出先打压不住的牌，跟牌按「这墩分归谁」给候选打分。
 */
import { RANKS, SUITS, cardPoints, identityKey, sumPoints, type Card, type Suit } from './cards.ts';
import { decompose, poolOf, type Component } from './combos.ts';
import { handSize } from './config.ts';
import { generateFollow, generateFollowWith, highestChooser, lowestChooser, validateFollow, type FollowChooser } from './follow.ts';
import { ctxOf, currentTurn, dealerTeam, declareLevel } from './reducer.ts';
import type { Rng } from './rng.ts';
import type { Action, FriendCallSpec, GameState, Seat } from './state.ts';
import { trickWinner, type TrickPlay } from './trick.ts';
import { groupOf, ordinal, type Group, type TrumpCtx } from './trump.ts';
import { possibleDeclarations } from './bot.ts';

/** 可单独开关的策略特性，用于做 A/B 对比。 */
export interface SmartFeatures {
  /** 按发牌进度外推牌力的亮主 */
  readonly declare: boolean;
  /** 只叫自己没有的牌、优先缺门 A 的叫朋友 */
  readonly call: boolean;
  /** 首出：帮朋友现身、抢末墩 */
  readonly lead: boolean;
  /** 跟牌：稳墩判断、末墩加权 */
  readonly follow: boolean;
  /** 四人对家模式专用：主牌计数拉主、闲家留对子抢底、庄家留大主保底、对家配合 */
  readonly partner: boolean;
}

export const SMART_V1: SmartFeatures = { declare: false, call: false, lead: false, follow: false, partner: false };
export const SMART_V2: SmartFeatures = { declare: true, call: true, lead: true, follow: true, partner: true };

/** 四人对家模式的专用规则是否生效 */
function partnerRules(s: GameState, f: SmartFeatures): boolean {
  return f.partner && smartTuning.partnerRules > 0 && s.config.friendCount === 0;
}

/** 兼容旧接口：1 是第一版，2 是全部特性 */
export type SmartLevel = 1 | 2 | SmartFeatures;

function featuresOf(level: SmartLevel): SmartFeatures {
  if (level === 1) return SMART_V1;
  if (level === 2) return SMART_V2;
  return level;
}

// ---------- 记牌 ----------

/** 每个身份还有多少张在别人手里（或未知的底牌里）。 */
export function unseenCounts(s: GameState, seat: Seat): Map<string, number> {
  const counts = new Map<string, number>();
  const dec = (c: Card) => counts.set(identityKey(c), (counts.get(identityKey(c)) ?? s.config.decks) - 1);
  // 先把所有身份初始化为 3
  for (const suit of SUITS) for (const rank of RANKS) counts.set(`${suit}${rank}`, s.config.decks);
  counts.set('J15', s.config.decks);
  counts.set('J16', s.config.decks);
  for (const c of s.hands[seat] ?? []) dec(c);
  for (const t of s.tricks) for (const p of t.plays) for (const c of p.cards) dec(c);
  if (s.trick) for (const p of s.trick.plays) for (const c of p.cards) dec(c);
  if (seat === s.dealer) for (const c of s.bottom) dec(c);
  return counts;
}

/** 别人手里还可能有压过该组件的牌吗？ */
function beatable(comp: Component, group: Group, unseen: Map<string, number>, ctx: TrumpCtx): boolean {
  const higher: { ord: number; count: number }[] = [];
  for (const [key, count] of unseen) {
    if (count <= 0) continue;
    const suit = key[0] as Card['suit'];
    const rank = Number(key.slice(1));
    const card: Card = { id: key, suit, rank, deck: 0 };
    if (groupOf(card, ctx) !== group) continue;
    const o = ordinal(card, ctx);
    if (o > comp.top) higher.push({ ord: o, count });
  }
  if (comp.kind === 'single') return higher.length > 0;
  if (comp.kind === 'pair') return higher.some((h) => h.count >= 2);
  if (comp.kind === 'triple') return higher.some((h) => h.count >= 3);
  // 拖拉机：需要连续序位都还剩 mult 张以上
  const ords = new Set(higher.filter((h) => h.count >= comp.mult).map((h) => h.ord));
  for (const o of ords) {
    let ok = true;
    for (let i = 0; i < comp.length; i++) if (!ords.has(o + i)) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/** 谁在哪个组已经断门：跟牌时出了别的组的牌，就说明没有该组的牌了。 */
export function knownVoids(s: GameState): Map<Seat, Set<Group>> {
  const out = new Map<Seat, Set<Group>>();
  const ctx = ctxOf(s);
  const scan = (leader: Seat, plays: readonly TrickPlay[], lead: { group: Group } | null) => {
    if (!lead) return;
    for (const p of plays) {
      if (p.seat === leader) continue;
      if (p.cards.some((c) => groupOf(c, ctx) !== lead.group)) {
        const set = out.get(p.seat) ?? new Set<Group>();
        set.add(lead.group);
        out.set(p.seat, set);
      }
    }
  };
  for (const t of s.tricks) {
    const first = t.plays[0];
    if (first) scan(t.leader, t.plays, decompose(first.cards, ctx));
  }
  if (s.trick) scan(s.trick.leader, s.trick.plays, s.trick.lead);
  // 推断：庄家叫了某门的朋友，又领出过那门，说明他把那门垫到只剩引牌了；引牌领完就当他断门
  if (s.dealer !== null) {
    const leadsBySuit = new Map<Group, number>();
    const countLead = (leader: Seat, plays: readonly TrickPlay[]) => {
      if (leader !== s.dealer) return;
      const first = plays[0];
      if (!first) return;
      const g = groupOf(first.cards[0] as Card, ctx);
      leadsBySuit.set(g, (leadsBySuit.get(g) ?? 0) + 1);
    };
    for (const t of s.tricks) countLead(t.leader, t.plays);
    if (s.trick) countLead(s.trick.leader, s.trick.plays);
    for (const call of s.friendCalls) {
      const calls = s.friendCalls.filter((c) => c.suit === call.suit).length;
      if ((leadsBySuit.get(call.suit) ?? 0) >= calls) {
        const set = out.get(s.dealer) ?? new Set<Group>();
        set.add(call.suit);
        out.set(s.dealer, set);
      }
    }
  }
  return out;
}

/** 外面还有多少张主牌 */
function unseenTrumps(unseen: Map<string, number>, ctx: TrumpCtx): number {
  let n = 0;
  for (const [key, count] of unseen) {
    if (count <= 0) continue;
    const card: Card = { id: key, suit: key[0] as Card['suit'], rank: Number(key.slice(1)), deck: 0 };
    if (groupOf(card, ctx) === 'T') n += count;
  }
  return n;
}

// ---------- 阵营 ----------

export interface Sides {
  /** 我这边的人，含自己 */
  mates: Set<Seat>;
  likelyDealerSide: boolean;
}

export function sidesOf(s: GameState, seat: Seat): Sides {
  const team = dealerTeam(s);
  const hand = s.hands[seat] ?? [];
  const holdsFriendCard = s.friendCalls.some((c) => c.resolvedSeat === null && hand.some((h) => h.suit === c.suit && h.rank === c.rank));
  if (team.includes(seat) || (holdsFriendCard && s.dealer !== null)) {
    const mates = new Set<Seat>(team);
    mates.add(seat);
    return { mates, likelyDealerSide: true };
  }
  const mates = new Set<Seat>([seat]);
  const allKnown = s.config.friendCount === 0 || (s.friendCalls.length > 0 && s.friendCalls.every((c) => c.resolvedSeat !== null));
  if (allKnown) for (let i = 0; i < s.config.players; i++) if (!team.includes(i)) mates.add(i);
  return { mates, likelyDealerSide: false };
}

// ---------- 亮主 ----------

export function smartDeclare(state: GameState, seat: Seat, _rng: Rng, level: SmartLevel = 2): Action | null {
  if (state.phase !== 'dealing' && state.phase !== 'declaring') return null;
  // 抢庄时（还没定庄家）各人亮自己的级牌，按自己的级来评估
  const s = state.dealer === null ? { ...state, level: declareLevel(state, seat) } : state;
  const options = possibleDeclarations(s, seat);
  if (options.length === 0) return null;
  return featuresOf(level).declare ? declareV2(s, seat, options) : declareV1(s, seat, options);
}

function declareV1(s: GameState, seat: Seat, options: Card[][]): Action | null {
  const hand = s.hands[seat] ?? [];
  const jokers = hand.filter((c) => c.suit === 'J').length;
  const levelCards = hand.filter((c) => c.rank === s.level).length;
  let best: { cards: Card[]; strength: number } | null = null;
  for (const cards of options) {
    const first = cards[0] as Card;
    let strength: number;
    if (first.suit === 'J') {
      strength = jokers * 2 + levelCards;
    } else {
      const suitCards = hand.filter((c) => c.suit === first.suit).length;
      const suitLevel = hand.filter((c) => c.suit === first.suit && c.rank === s.level).length;
      strength = suitCards + suitLevel * 2 + jokers;
    }
    if (s.declaration && s.declaration.seat === seat && s.declaration.suit === (first.suit === 'J' ? null : first.suit)) strength += 100;
    if (!best || strength > best.strength) best = { cards, strength };
  }
  if (!best) return null;
  const count = best.cards.length;
  const threshold = count >= 3 ? 0 : count === 2 ? 8 : 10;
  const bonus = s.dealer === null ? 1 : 0;
  if (best.strength + bonus < threshold) return null;
  return { type: 'declare', seat, cards: best.cards.map((c) => c.id) };
}

/** 假设某花色为主时这手牌的牌力，会按发牌进度外推最终主牌数。 */
export function trumpStrength(hand: readonly Card[], level: number, suit: Suit | null, progress: number): number {
  const ctx: TrumpCtx = { level, trumpSuit: suit };
  const trumps = hand.filter((c) => groupOf(c, ctx) === 'T');
  const p = Math.max(progress, 0.3);
  const expected = trumps.length / p;
  let high = 0;
  for (const c of trumps) {
    if (c.suit === 'J') high += c.rank === 16 ? 1.2 : 1;
    else if (c.rank === level) high += c.suit === suit ? 1 : 0.6;
    else if (c.rank === 14) high += 0.7;
    else if (c.rank === 13) high += 0.4;
  }
  const pool = poolOf(trumps, ctx);
  let pairs = 0;
  for (const id of pool.values()) if (id.cards.length >= 2) pairs += id.cards.length >= 3 ? 2 : 1;
  let voids = 0;
  if (suit !== null) {
    for (const other of SUITS) {
      if (other === suit) continue;
      if (!hand.some((c) => c.suit === other && c.rank !== level)) voids++;
    }
  }
  let strength = expected + high * 1.5 + pairs * 1.2 + voids * 1.5 * progress;
  // 无主通常对闲家有利（主牌少、四门副牌难控）；但级牌是 10 或 K 时领一对王能逼出分牌，很划算
  if (suit === null) strength += level === 10 || level === 13 ? 2.5 : -1.5;
  return strength;
}

/** 亮主阈值，可在模拟器里调参 */
export const smartTuning = {
  /** 四人对家专用规则总开关（1 开 0 关），A/B 用 */
  partnerRules: 1,
  /** 四人：每人剩这么多张以内开始为末墩布局 */
  prepHand: 9,
  /** 四人：闲家残局前领出稳赢对子的扣分（留到末墩抢底） */
  pairHoldPenalty: 45,
  /** 四人：拉主门槛，自己的主要比外面平均每人多这个倍数 */
  majorityFactor: 1.15,
  /** 四人：对手在赢、对家还没出时垫分牌的扣分系数 */
  holdPointsFactor: 0.5,
  /** 四人有主：庄家阵营主牌达到这个张数才主动吊主（两副牌共 36 张主，平均每人 9 张） */
  dealerDrawMin4: 11,
  /** 四人无主：全桌只有 12 张主，平均 3 张，达到这个张数就可以吊 */
  dealerDrawMin4NoTrump: 4,
  /** 四人：满足清主条件时领主对的加分 */
  clearTrumpBonus: 35,
  /** 四人：用主毙没分的墩的扣分 */
  noPointRuffPenalty: 8,
  /** 1：扣底按庄家计划垫绝朋友门；0：只用普通扣底打分（实验开关） */
  planDiscards: 1,
  /** 叫缺门（没有引牌）的 A 的扣分；默认 0：缺门就是最短的门，直接叫 */
  voidCallPenalty: 0,
  /** 1：叫朋友按庄家计划；0：用第二版原来的叫法（实验开关） */
  planCalls: 1,
  /** 庄家开局主动用引牌找朋友所需的最少主牌数；0 表示无条件先找队友 */
  openingMinTrumps: 0,
  declareSingle: 11.5,
  declarePair: 9.5,
  earlyPenalty: 1.5,
  lateBonus: 1.5,
  overridePenalty: 1,
};

function declareV2(s: GameState, seat: Seat, options: Card[][]): Action | null {
  const hand = s.hands[seat] ?? [];
  const progress = Math.min(1, hand.length / handSize(s.config));
  const current = s.declaration;
  let best: { cards: Card[]; strength: number; mine: boolean } | null = null;
  for (const cards of options) {
    const first = cards[0] as Card;
    const suit: Suit | null = first.suit === 'J' ? null : (first.suit as Suit);
    const mine = current !== null && current.seat === seat && current.suit === suit;
    const strength = trumpStrength(hand, s.level, suit, progress);
    if (!best) best = { cards, strength, mine };
    else if (mine !== best.mine) { if (mine) best = { cards, strength, mine }; }
    else if (strength > best.strength) best = { cards, strength, mine };
  }
  if (!best) return null;
  // 自己亮过的花色再多一张就加固，别人更难反
  if (best.mine) return { type: 'declare', seat, cards: best.cards.map((c) => c.id) };
  const count = best.cards.length;
  let threshold = count >= 3 ? 0 : count === 2 ? smartTuning.declarePair : smartTuning.declareSingle;
  // 抢庄（首局，或非首局底牌没有常主后重新抢庄）还没人亮：见级牌就亮，坐庄有底牌和先手，之后抓到第二张再加固
  if (s.dealer === null && !current && best.cards[0]?.suit !== 'J') threshold = 0;
  // 发牌早期手牌还不全，谨慎一点；快发完了还没人亮，就放低要求抢庄
  if (progress < 0.5) threshold += smartTuning.earlyPenalty;
  if (!current && progress > 0.85) threshold -= smartTuning.lateBonus;
  // 反别人的主要更有把握
  if (current && current.seat !== seat) threshold += smartTuning.overridePenalty;
  if (best.strength < threshold) return null;
  return { type: 'declare', seat, cards: best.cards.map((c) => c.id) };
}

// ---------- 扣底 ----------

// ---------- 庄家计划：叫哪门朋友，就把那门垫到只剩要用的牌 ----------

export interface DealerPlan {
  readonly calls: FriendCallSpec[];
  /** 计划里必须留在手上的牌 */
  readonly keep: Set<string>;
  /** 扣底时优先垫掉的牌（朋友花色里多余的牌） */
  readonly dumps: Card[];
}

interface SuitPlan {
  suit: Suit;
  rank: number;
  held: number;
  outside: number;
  /** 保留：自己的朋友牌 + 每个叫法一张引牌 */
  keep: Card[];
  dumps: Card[];
  callsInSuit: number;
  score: number;
}

/**
 * 给某个副牌花色做计划：叫第 held+1 张（自己有几张就叫下一张），
 * 留下自己的那几张加上 callsInSuit 张最小的引牌，其余全垫掉。
 */
function suitPlan(s: GameState, hand: readonly Card[], suit: Suit, callsInSuit: number, bottomKnown: readonly Card[]): SuitPlan | null {
  const ctx = ctxOf(s);
  const rank = s.level === 14 ? 13 : 14;
  const cards = hand.filter((c) => c.suit === suit && groupOf(c, ctx) !== 'T');
  const friendCards = cards.filter((c) => c.rank === rank);
  const others = cards.filter((c) => c.rank !== rank).sort((a, b) => ordinal(a, ctx) - ordinal(b, ctx));
  const held = friendCards.length;
  const buried = bottomKnown.filter((c) => c.suit === suit && c.rank === rank).length;
  const outside = s.config.decks - held - buried;
  if (outside < callsInSuit) return null;
  const leads = others.slice(0, callsInSuit);
  const dumps = others.slice(callsInSuit);
  // 为了垫绝门而把分牌或 K 埋进底牌得不偿失：这样的门不作为计划，退回普通扣底
  let dumpPoints = 0;
  for (const c of dumps) dumpPoints += cardPoints(c);
  if (dumpPoints > 5 || dumps.some((c) => c.rank >= 13)) return null;
  // 尽量挑最短的一门：缺门最好，其次单张；垫得越少越好，自己有 A 的门尽量不叫
  let score = 40 - cards.length * 5 - dumps.length * 3 - dumpPoints * 3;
  score -= held * 14; // 自己有 A 就得先打完自己的才轮到朋友的，朋友现身慢很多
  if (leads.length < callsInSuit) score -= smartTuning.voidCallPenalty;
  return { suit, rank, held, outside, keep: [...friendCards, ...leads], dumps, callsInSuit, score };
}

/**
 * 庄家计划：选一门副牌叫朋友，把这门垫到只剩要用的牌。
 * 两个朋友时优先同一门叫「第 n、n+1 张」，垫牌不够再考虑第二门。
 */
export function planDealer(s: GameState, seat: Seat): DealerPlan {
  if (s.config.friendCount === 0) return { calls: [], keep: new Set(), dumps: [] };
  const hand = s.hands[seat] ?? [];
  const bottomKnown = s.phase === 'bottom' ? [] : s.bottom;
  // 扣底阶段可以垫 bottomSize 张；叫朋友阶段牌已定，只能选已经垫干净的门
  const budget = s.phase === 'bottom' ? s.config.bottomSize : 0;
  const k = s.config.friendCount;
  const suits = SUITS.filter((x) => x !== s.trumpSuit);
  interface Option { plans: SuitPlan[]; score: number; dumps: number }
  const options: Option[] = [];
  for (const x of suits) {
    // 没有 A 就不叫第二、三张：一门只叫一张，序号永远是自己持有数加一
    if (k === 1) {
      const one = suitPlan(s, hand, x, 1, bottomKnown);
      if (one && one.dumps.length <= budget) options.push({ plans: [one], score: one.score, dumps: one.dumps.length });
    }
    if (k === 2) {
      const first = suitPlan(s, hand, x, 1, bottomKnown);
      if (!first) continue;
      for (const y of suits) {
        if (y === x) continue;
        const second = suitPlan(s, hand, y, 1, bottomKnown);
        if (!second) continue;
        const dumps = first.dumps.length + second.dumps.length;
        if (dumps > budget) continue;
        // 两个朋友尽量在不同门：同一门叫第 n、n+1 张时，两张 A 常在同一人手里，结果只找到一个朋友
        options.push({ plans: [first, second], score: first.score + second.score + 14, dumps });
      }
    }
  }
  const v2calls = (callFriendV2(s, seat) as Extract<Action, { type: 'callFriend' }>).calls as FriendCallSpec[];
  if (options.length === 0) {
    // 两个朋友但垫不出两门：第一门按计划垫，第二个朋友按普通叫法挑另一门
    if (k === 2) {
      let bestOne: SuitPlan | null = null;
      for (const x of suits) {
        const one = suitPlan(s, hand, x, 1, bottomKnown);
        if (one && one.dumps.length <= budget && (!bestOne || one.score > bestOne.score)) bestOne = one;
      }
      const other = bestOne ? v2calls.find((c) => c.suit !== bestOne!.suit) ?? null : null;
      if (bestOne && other) {
        return {
          calls: [{ suit: bestOne.suit, rank: bestOne.rank, nth: Math.min(s.config.decks, bestOne.held + 1) }, other],
          keep: new Set(bestOne.keep.map((c) => c.id)),
          dumps: bestOne.dumps,
        };
      }
    }
    // 垫不干净任何一门：退回第二版的叫法，不刻意垫牌
    return { calls: v2calls, keep: new Set(), dumps: [] };
  }
  options.sort((a, b) => b.score - a.score);
  const best = options[0] as Option;
  const calls: FriendCallSpec[] = [];
  const keep = new Set<string>();
  const dumps: Card[] = [];
  for (const p of best.plans) {
    for (let i = 0; i < p.callsInSuit; i++) calls.push({ suit: p.suit, rank: p.rank, nth: Math.min(s.config.decks, p.held + 1 + i) });
    for (const c of p.keep) keep.add(c.id);
    dumps.push(...p.dumps);
  }
  void best;
  return { calls, keep, dumps };
}

/** 扣底候选集合：第二版的首选，加上把末位几张分别换成下一张的变体 */
export function rankedBottomSets(s: GameState, seat: Seat, maxSets = 6): Card[][] {
  const plan = smartTuning.planDiscards ? planDealer(s, seat) : { calls: [], keep: new Set<string>(), dumps: [] as Card[] };
  const ranked = rankBottomDiscards(s, seat).filter((c) => !plan.keep.has(c.id) && !plan.dumps.some((d) => d.id === c.id));
  const n = s.config.bottomSize;
  const base = [...plan.dumps.slice(0, n), ...ranked].slice(0, n);
  const sets: Card[][] = [base];
  // 普通扣底（不为找朋友垫门）也作为候选，加强版由推演决定用哪个
  const plain = rankBottomDiscards(s, seat).slice(0, n);
  if (plain.map((c) => c.id).sort().join() !== base.map((c) => c.id).sort().join()) sets.push(plain);
  if (plan.dumps.length >= n || maxSets <= sets.length) return sets.slice(0, Math.max(1, maxSets));
  for (let swapOut = n - 1; swapOut >= Math.max(0, n - 3) && sets.length < maxSets; swapOut--) {
    for (let swapIn = n; swapIn < Math.min(ranked.length, n + 3) && sets.length < maxSets; swapIn++) {
      const v = [...base];
      v[swapOut] = ranked[swapIn] as Card;
      sets.push(v);
    }
  }
  return sets;
}

function rankBottomDiscards(s: GameState, seat: Seat): Card[] {
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  const bySuit = new Map<Group, Card[]>();
  for (const c of hand) bySuit.set(groupOf(c, ctx), [...(bySuit.get(groupOf(c, ctx)) ?? []), c]);
  const pool = poolOf(hand, ctx);
  // 四人对家模式：一定要绝一门副牌，这是和对家过桥的通道。挑最短、没有 A 的一门，整门加权
  const partner = smartTuning.partnerRules > 0 && s.config.friendCount === 0;
  let voidSuit: Group | null = null;
  if (partner) {
    const cands = [...bySuit.entries()].filter(([g]) => g !== 'T').map(([g, cs]) => ({ g, len: cs.length, hasAce: cs.some((x) => x.rank === 14), pts: sumPoints(cs) }));
    cands.sort((a, b) => Number(a.hasAce) - Number(b.hasAce) || a.len - b.len || a.pts - b.pts);
    // 底里最多放 5 分。这是软偏好：整门加 20 分，同种子 320 局对照里比强制绝门（加 45）每轮升级高约 0.01
    const pick = cands.find((x) => x.len <= s.config.bottomSize && x.pts <= 5) ?? cands.find((x) => x.len <= s.config.bottomSize) ?? null;
    voidSuit = pick?.g ?? null;
  }
  const scored = hand.map((c) => {
    const g = groupOf(c, ctx);
    const suitLen = bySuit.get(g)?.length ?? 0;
    const copies = pool.get(identityKey(c))?.cards.length ?? 1;
    let score = 30 - ordinal(c, ctx);
    if (g === 'T') score -= 40;
    if (cardPoints(c) > 0) score -= 25;
    if (g !== 'T') score += Math.max(0, 8 - suitLen) * 3;
    // 没分的副牌小对不必留（四人）；其他模式留对子跟牌
    if (copies >= 2 && !(partner && g !== 'T' && cardPoints(c) === 0 && c.rank < 13)) score -= 12;
    if (c.rank === 14 && g !== 'T') score -= 15;
    if (voidSuit !== null && g === voidSuit) score += 20;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.c);
}

export function smartExchangeBottom(s: GameState, seat: Seat, _rng: Rng): Action {
  const best = rankedBottomSets(s, seat, 1)[0] as Card[];
  return { type: 'exchangeBottom', seat, cards: best.map((c) => c.id) };
}

// ---------- 叫朋友 ----------

export function smartCallFriend(s: GameState, seat: Seat, _rng: Rng, level: SmartLevel = 2): Action {
  if (!featuresOf(level).call) return callFriendV1(s, seat);
  if (!smartTuning.planCalls) return callFriendV2(s, seat);
  return { type: 'callFriend', seat, calls: planDealer(s, seat).calls };
}

/** 兜底补齐叫法：不同花色、不同点数各试一遍，序号始终是自己持有数加一，绝不叫自己没有的第二张 */
function fillCalls(s: GameState, hand: readonly Card[], calls: FriendCallSpec[]): void {
  const key = (c: FriendCallSpec) => `${c.suit}${c.rank}#${c.nth}`;
  for (const suit of SUITS) {
    if (calls.length >= s.config.friendCount) break;
    if (suit === s.trumpSuit) continue;
    for (const rank of [14, 13, 12, 11]) {
      if (calls.length >= s.config.friendCount) break;
      if (rank === s.level) continue;
      const mine = hand.filter((c) => c.suit === suit && c.rank === rank).length;
      if (mine >= s.config.decks) continue;
      const spec: FriendCallSpec = { suit, rank, nth: mine + 1 };
      if (!calls.some((c) => key(c) === key(spec))) calls.push(spec);
    }
  }
}

function callFriendV1(s: GameState, seat: Seat): Action {
  const hand = s.hands[seat] ?? [];
  const candidates: { call: FriendCallSpec; score: number }[] = [];
  for (const suit of SUITS) {
    if (suit === s.trumpSuit) continue;
    const suitCards = hand.filter((c) => c.suit === suit).length;
    for (const rank of [14, 13, 12]) {
      if (rank === s.level) continue;
      const held = hand.filter((c) => c.suit === suit && c.rank === rank).length;
      if (held >= s.config.decks) continue;
      const score = (rank === 14 ? 30 : rank === 13 ? 12 : 4) - suitCards * 2 - held * 6;
      candidates.push({ call: { suit, rank, nth: Math.min(s.config.decks, held + 1) }, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const calls: FriendCallSpec[] = [];
  const usedSuits = new Set<Suit>();
  for (const cand of candidates) {
    if (calls.length >= s.config.friendCount) break;
    if (usedSuits.has(cand.call.suit) && candidates.some((x) => !usedSuits.has(x.call.suit) && !calls.includes(x.call))) continue;
    calls.push(cand.call);
    usedSuits.add(cand.call.suit);
  }
  fillCalls(s, hand, calls);
  return { type: 'callFriend', seat, calls };
}

/**
 * 叫朋友第二版：只叫自己手里和底牌里都没有的牌，序号一律「第一张」，谁先打出谁就是朋友，不会被自己的牌搅乱；
 * 优先缺门或短门的 A，朋友的 A 能赢墩，自己还能毙；两个朋友尽量不同花色，让更多人有机会成为朋友。
 */
/** 叫朋友的候选集合，按第二版打分从高到低，最多 maxSets 组，供搜索机器人逐一推演 */
export function rankedFriendCallSets(s: GameState, seat: Seat, maxSets = 6): FriendCallSpec[][] {
  const hand = s.hands[seat] ?? [];
  const bottom = s.bottom;
  const count = (cards: readonly Card[], suit: Suit, rank: number) => cards.filter((c) => c.suit === suit && c.rank === rank).length;
  const cands: { call: FriendCallSpec; score: number }[] = [];
  for (const suit of SUITS) {
    if (suit === s.trumpSuit) continue;
    const suitLen = hand.filter((c) => c.suit === suit).length;
    for (const rank of [14, 13, 12, 11]) {
      if (rank === s.level) continue;
      const mine = count(hand, suit, rank);
      const buried = count(bottom, suit, rank);
      const outside = s.config.decks - mine - buried;
      if (outside <= 0) continue;
      let score = rank === 14 ? 40 : rank === 13 ? 20 : rank === 12 ? 8 : 2;
      score -= suitLen * 3;
      score -= mine * 12;
      cands.push({ call: { suit, rank, nth: Math.min(s.config.decks, mine + 1) }, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, 6).map((c) => c.call);
  const key = (c: FriendCallSpec) => `${c.suit}${c.rank}#${c.nth}`;
  const sets: FriendCallSpec[][] = [];
  const k = s.config.friendCount;
  const rec = (start: number, acc: FriendCallSpec[]) => {
    if (acc.length === k) { sets.push([...acc]); return; }
    for (let i = start; i < top.length; i++) {
      if (acc.some((x) => key(x) === key(top[i] as FriendCallSpec))) continue;
      acc.push(top[i] as FriendCallSpec); rec(i + 1, acc); acc.pop();
    }
  };
  rec(0, []);
  // 不同花色优先排前面
  sets.sort((a, b) => new Set(b.map((x) => x.suit)).size - new Set(a.map((x) => x.suit)).size);
  // 庄家计划（垫绝门那一叫）永远放第一
  const planned = planDealer(s, seat).calls;
  const keyOf = (set: FriendCallSpec[]) => set.map(key).sort().join('|');
  const rest = sets.filter((x) => keyOf(x) !== keyOf(planned));
  return [planned, ...rest].slice(0, maxSets);
}

function callFriendV2(s: GameState, seat: Seat): Action {
  const hand = s.hands[seat] ?? [];
  const bottom = s.bottom;
  const count = (cards: readonly Card[], suit: Suit, rank: number) => cards.filter((c) => c.suit === suit && c.rank === rank).length;
  interface Cand { call: FriendCallSpec; score: number }
  const cands: Cand[] = [];
  for (const suit of SUITS) {
    if (suit === s.trumpSuit) continue;
    const suitLen = hand.filter((c) => c.suit === suit).length;
    for (const rank of [14, 13, 12, 11]) {
      if (rank === s.level) continue;
      const mine = count(hand, suit, rank);
      const buried = count(bottom, suit, rank);
      const outside = s.config.decks - mine - buried;
      if (outside <= 0) continue;
      let score = rank === 14 ? 40 : rank === 13 ? 20 : rank === 12 ? 8 : 2;
      score -= suitLen * 3;          // 越短越好，缺门最好
      score -= mine * 12;            // 自己有这张牌会搅乱序号
      score += outside === s.config.decks ? 3 : 0;
      // 序号：自己没有就叫第一张；自己有 k 张，叫第 k+1 张只是权宜
      const nth = Math.min(s.config.decks, mine + 1);
      cands.push({ call: { suit, rank, nth }, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const calls: FriendCallSpec[] = [];
  const key = (c: FriendCallSpec) => `${c.suit}${c.rank}#${c.nth}`;
  // 第一轮：不同花色优先
  for (const c of cands) {
    if (calls.length >= s.config.friendCount) break;
    if (calls.some((x) => x.suit === c.call.suit)) continue;
    calls.push(c.call);
  }
  // 第二轮：补齐
  for (const c of cands) {
    if (calls.length >= s.config.friendCount) break;
    if (calls.some((x) => key(x) === key(c.call))) continue;
    calls.push(c.call);
  }
  fillCalls(s, hand, calls);
  return { type: 'callFriend', seat, calls };
}

// ---------- 出牌 ----------

interface LeadCandidate { cards: Card[]; score: number }

// ---------- 四人对家模式的人类固定打法（来源见设计文档 3.6.3） ----------

interface PartnerLeadCtx {
  readonly s: GameState;
  readonly seat: Seat;
  readonly sides: Sides;
  readonly ctx: TrumpCtx;
  readonly hand: readonly Card[];
  readonly g: Group;
  readonly suitCards: readonly Card[];
  readonly comp: Component;
  readonly isSafe: boolean;
  /** 本组稳赢组件数 */
  readonly safeCount: number;
  readonly pts: number;
  readonly trumpCount: number;
  readonly voids: Map<Seat, Set<Group>>;
  readonly lastTrick: boolean;
  readonly byGroup: Map<Group, Card[]>;
}

/** 某方是否在之前的墩里领出过主对（含拖拉机） */
function ledTrumpPairsBefore(s: GameState, seats: ReadonlySet<Seat>): boolean {
  const ctx = ctxOf(s);
  for (const t of s.tricks) {
    const first = t.plays[0];
    if (!first || !seats.has(t.leader)) continue;
    if (first.cards.length >= 2 && first.cards.every((c) => groupOf(c, ctx) === 'T')) return true;
  }
  return false;
}

/** 庄家最近三墩里是否领过主：中途吊主是「对家来帮我拉主」的信号 */
function dealerLedTrumpRecently(s: GameState): boolean {
  const ctx = ctxOf(s);
  const recent = s.tricks.slice(-3);
  return recent.some((t) => t.leader === s.dealer && (t.plays[0]?.cards ?? []).every((c) => groupOf(c, ctx) === 'T'));
}

/**
 * 四人对家模式首出的固定打法加权。返回加到规则打分上的分。
 * 只在 partnerRules 生效时调用。
 */
function partnerLeadBonus(c: PartnerLeadCtx): number {
  const { s, seat, sides, ctx, hand, g, suitCards, comp, isSafe, safeCount, pts, trumpCount, voids, lastTrick, byGroup } = c;
  const dealer = s.dealer as Seat;
  const isDealer = seat === dealer;
  const isPartner = sides.likelyDealerSide && !isDealer;
  let b = 0;
  const trumpDecomp = decompose(byGroup.get('T') ?? [], ctx);
  const trumpPairs = trumpDecomp ? trumpDecomp.components.reduce((n, x) => n + (x.mult >= 2 ? x.length : 0), 0) : 0;
  const bigJokerPair = hand.filter((x) => x.suit === 'J' && x.rank === 16).length >= 2;
  const handHasTractor = [...byGroup.values()].some((cards) => decompose(cards, ctx)?.components.some((x) => x.kind === 'tractor'));

  if (g === 'T' && !isSafe) {
    // 清主：四个以上主对，或三个主对带一对大王，上手就打主对，一连四对外面基本没主了
    const clearing = sides.likelyDealerSide && (trumpPairs >= 4 || (trumpPairs >= 3 && bigJokerPair));
    if (clearing && comp.kind !== 'single') b += smartTuning.clearTrumpBonus;
    // 起了主对之后勿打单张，否则给对手机会
    if (clearing && comp.kind === 'single' && ledTrumpPairsBefore(s, sides.mates)) b -= 15;
    // 三个主对没有大王对：先单吊两三轮再清主
    if (sides.likelyDealerSide && !clearing && trumpPairs === 3 && comp.kind === 'single' && s.tricks.length < 6) b += 12;
    // 庄家中途吊主是信号：对家停出副牌，跟着拉主
    if (isPartner && dealerLedTrumpRecently(s) && trumpCount >= 2) b += 15;
    // 对手在某门断门而我那门有对子：先出主对拉掉他的主，副对才安全
    if (comp.kind !== 'single') {
      for (const [sg, sc] of byGroup) {
        if (sg === 'T') continue;
        const hasPair = (decompose(sc, ctx)?.components ?? []).some((x) => x.mult >= 2);
        if (!hasPair) continue;
        let foeVoid = false;
        for (let i = 0; i < s.config.players; i++) if (!sides.mates.has(i) && voids.get(i)?.has(sg)) foeVoid = true;
        if (foeVoid) { b += 12; break; }
      }
    }
  }
  if (g !== 'T') {
    const first = comp.cards[0] as Card;
    const suitLen = suitCards.length;
    const aces = suitCards.filter((x) => x.rank === 14).length;
    const kings = suitCards.filter((x) => x.rank === 13).length;
    const suitComps = decompose(suitCards, ctx)?.components ?? [];
    const pairsHere = suitComps.reduce((n, x) => n + (x.mult >= 2 ? x.length : 0), 0);
    const isAceSingle = comp.kind === 'single' && first.rank === 14;
    // 庄家：副牌留 A 加单张不打，A 留着进手、压制对手甩牌、跑对家的分（开局前八墩）
    if (isDealer && isAceSingle && suitLen <= 2 && s.tricks.length < 8 && !lastTrick) b -= 18;
    // 有 AK 带一对的副牌，先出一张小牌问路
    if (aces >= 1 && kings >= 1 && pairsHere >= 1 && comp.kind === 'single' && first.rank < 13 && pts === 0) b += 14;
    // 某门副牌只剩一张（不管是不是分），主动打出去，免得以后被迫垫分
    if (suitLen === 1 && first.rank !== 14 && !isSafe && !lastTrick) b += 10;
    // 无分的副牌有多对，赶快出，可能抓到对 10、对 K
    if (sumPoints(suitCards) === 0 && pairsHere >= 2 && comp.kind !== 'single' && !isSafe) b += 10;
    if (isPartner) {
      // 对家：先出庄家还有牌的门的 A（让庄家跑分），再出庄家已断门的 A
      if (isSafe && isAceSingle) b += voids.get(dealer)?.has(g) ? -8 : 8;
      // 对家不该藏单 A
      if (suitLen === 1 && first.rank === 14) b += 12;
      // 对家出完大牌只剩小对时不冲小对，改为吊主或刺庄家断门把牌权还给庄家
      if (!isSafe && comp.kind === 'pair' && safeCount === 0) b -= 12;
      if (!isSafe && comp.kind === 'single' && safeCount === 0 && pts === 0 && voids.get(dealer)?.has(g)) b += 10;
    }
    // 守庄方有连对：先出旁门 A 再出连对，免得旁门的分被人跑掉
    if (sides.likelyDealerSide && isSafe && isAceSingle && handHasTractor) b += 10;
  }
  return b;
}

function leadCandidates(s: GameState, seat: Seat, sides: Sides, unseen: Map<string, number>, f: SmartFeatures): LeadCandidate[] {
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  const lastTrick = f.lead && hand.length <= 3;
  const unresolvedCalls = f.lead && seat === s.dealer ? s.friendCalls.filter((c) => c.resolvedSeat === null) : [];
  const voids = f.lead ? knownVoids(s) : new Map<Seat, Set<Group>>();
  const trumpsOutside = f.lead ? unseenTrumps(unseen, ctx) : 0;
  const mateVoid = (g: Group) => [...sides.mates].some((m) => m !== seat && voids.get(m)?.has(g));
  const foeVoid = (g: Group) => {
    for (let i = 0; i < s.config.players; i++) if (!sides.mates.has(i) && voids.get(i)?.has(g)) return true;
    return false;
  };
  const byGroup = new Map<Group, Card[]>();
  for (const c of hand) byGroup.set(groupOf(c, ctx), [...(byGroup.get(groupOf(c, ctx)) ?? []), c]);
  const trumpCount = byGroup.get('T')?.length ?? 0;
  const partner = partnerRules(s, f);
  // 四人：残局前几墩（每人还剩 6 到 9 张）是为末墩布局的时候
  const endgamePrep = partner && hand.length <= smartTuning.prepHand && !lastTrick;
  // 四人主牌计数：自己的主比外面平均每人多就拉主；闲家也一样，把庄家的主拉光他就毙不了。
  // 无主时全桌只有 12 张主（4 张王 + 8 张级牌），门槛按比例缩小
  const noTrump = ctx.trumpSuit === null;
  const majorityMin = noTrump ? 3 : 8;
  const trumpMajority = partner && trumpCount >= majorityMin && trumpCount * (s.config.players - 1) > trumpsOutside * smartTuning.majorityFactor;
  const out: LeadCandidate[] = [];
  for (const [g, cards] of byGroup) {
    const d = decompose(cards, ctx);
    if (!d) continue;
    const safe = d.components.filter((c) => !beatable(c, g, unseen, ctx));
    for (const comp of d.components) {
      const pts = sumPoints(comp.cards);
      const isSafe = safe.includes(comp);
      let score: number;
      if (isSafe) {
        score = 100 + comp.cards.length * 10 + pts * 2;
        if (g === 'T' && !sides.likelyDealerSide && trumpCount < 6 && !trumpMajority) score -= 30; // 闲家别急着放主
        // 先出短门的强牌，再出长门的，防止被人趁机绝门
        if (g !== 'T') score += Math.max(0, 6 - cards.length);
      } else if (g === 'T') {
        // 庄家阵营主牌够多就拉主，朋友都现身后配合更明确，门槛放低
        const allKnown = s.config.friendCount === 0 || (s.friendCalls.length > 0 && s.friendCalls.every((c) => c.resolvedSeat !== null));
        // 四人有主：庄家阵营主牌达到 dealerDrawMin4（11 张）以上才主动吊主；无主除外，无主 4 张（平均 3 张）就可以吊
        const drawMin = partner ? (noTrump ? smartTuning.dealerDrawMin4NoTrump : smartTuning.dealerDrawMin4) : allKnown ? 7 : 8;
        const drawTrumps = (sides.likelyDealerSide && trumpCount >= drawMin) || trumpMajority;
        score = (drawTrumps ? 60 : 15) - comp.top - pts * 4 - (comp.cards.length - 1) * 8;
      } else {
        score = 40 - comp.top - pts * 5 + Math.max(0, 8 - cards.length) * 2 - (comp.cards.length - 1) * 6;
        // 庄家先找朋友：用朋友牌花色里比朋友牌小的牌引牌，让握着朋友牌的人尽早现身并赢墩。
        // 越早越值得，前几墩加得多；单张最好，小对子也行
        const call = unresolvedCalls.find((c) => c.suit === g);
        if (call && comp.kind === 'single'
          && comp.cards.every((c) => c.rank !== call.rank && ordinal(c, ctx) < ordinal({ ...c, rank: call.rank }, ctx))) {
          const callsHere = unresolvedCalls.filter((c) => c.suit === g).length;
          const leadsLeft = cards.filter((c) => c.rank !== call.rank).length;
          const early = Math.max(0, 4 - s.tricks.length);
          // 这门已经垫到只剩引牌：这张就是留着找朋友的，尽早打出去
          if (leadsLeft <= callsHere) score += 40 + early * 3;
          // 否则只在开局前几墩、主牌够硬、用无分小单张时去找
          else if (pts === 0 && trumpCount >= 7) score += 18 + early * 3;
        }
      }
      // 握着朋友牌且轮到自己首出：领出朋友牌本身（通常是稳赢的 A）就能亮身份，尽早
      if (f.lead && seat !== s.dealer && sides.likelyDealerSide
        && s.friendCalls.some((c) => c.resolvedSeat === null && comp.cards.some((x) => x.suit === c.suit && x.rank === c.rank))) {
        score += 30 + Math.max(0, 10 - s.tricks.length) * 2;
      }
      // 连对拖拉机要早出，免得被别人领一对拆散
      if (f.lead && comp.kind === 'tractor' && s.tricks.length < 10) score += 16 + Math.max(0, 6 - s.tricks.length) * 2;
      // 领小主让队友接管：阵营已明、自己没有稳赢的牌、手里有小主时，用小主把上手权交给队友的大主
      if (f.lead && g === 'T' && comp.kind === 'single' && sides.mates.size > 1 && safe.length === 0 && comp.top <= 5 && trumpsOutside > 0 && !lastTrick) score += 12;
      // 最后几墩：能赢就赢，末墩关系到抠底
      if (lastTrick && isSafe) score += 30;
      if (endgamePrep) {
        if (!sides.likelyDealerSide) {
          // 闲家抢底：底牌 8 张，末墩用对子赢是四倍、拖拉机八倍。稳赢的对子、拖拉机留到最后，先用单张清场
          if (isSafe && comp.kind !== 'single') score -= smartTuning.pairHoldPenalty;
          else if (comp.kind === 'single' && g !== 'T') score += 6;
        } else {
          // 庄家保底：最大的主留到末墩压闲家的对子，先出别的
          if (g === 'T' && isSafe && comp.kind === 'single' && comp === safe[0] && safe.length === 1) score -= 20;
        }
      }
      if (f.lead && g !== 'T' && trumpsOutside > 0) {
        // 对手已经断门会来毙，尤其别送分；队友断门则可以喂他毙，带分的牌最好
        if (foeVoid(g)) score -= isSafe ? 45 : 10 + pts * 3;
        else if (mateVoid(g) && !isSafe) score += 22 + pts * 4;
      }
      if (partner) score += partnerLeadBonus({ s, seat, sides, ctx, hand, g, suitCards: cards, comp, isSafe, safeCount: safe.length, pts, trumpCount, voids, lastTrick, byGroup });
      out.push({ cards: [...comp.cards], score });
    }
    // 甩牌：两个以上都安全的组件一起出
    if (safe.length >= 2) {
      const cards = safe.flatMap((c) => [...c.cards]);
      out.push({ cards, score: 120 + cards.length * 10 + sumPoints(cards) * 2 });
    }
  }
  return out;
}

function cardCost(c: Card, ctx: TrumpCtx): number {
  return ordinal(c, ctx) + (groupOf(c, ctx) === 'T' ? 14 : 0);
}

function dedupe(cands: Card[][]): Card[][] {
  const seen = new Set<string>();
  const out: Card[][] = [];
  for (const c of cands) {
    const key = c.map((x) => x.id).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** 给点数优先、其次尽量小的补牌策略 */
function pointsChooser(ctx: TrumpCtx): FollowChooser {
  const low = lowestChooser(ctx);
  return {
    ...low,
    fill: (cards, n) => [...cards].sort((a, b) => cardPoints(b) - cardPoints(a) || ordinal(a, ctx) - ordinal(b, ctx)).slice(0, n),
  };
}

/** 没有该花色时，用主牌凑出首出的形状来毙 */
function ruffCandidates(s: GameState, seat: Seat): Card[][] {
  const trick = s.trick;
  const lead = trick?.lead;
  if (!lead || lead.group === 'T') return [];
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  if (hand.some((c) => groupOf(c, ctx) === lead.group)) return [];
  const trumps = hand.filter((c) => groupOf(c, ctx) === 'T');
  const d = decompose(trumps, ctx);
  if (!d) return [];
  const out: Card[][] = [];
  if (lead.components.length === 1) {
    const shape = lead.components[0] as Component;
    for (const comp of d.components) {
      if (comp.mult === shape.mult && comp.length === shape.length) out.push([...comp.cards]);
      // 拆三条当对子
      if (shape.kind === 'pair' && comp.kind === 'triple') out.push(comp.cards.slice(0, 2));
    }
  }
  return out;
}

/**
 * 目前赢家的牌后面的人还压得住吗？
 * 主牌首出：看外面还有没有更大的主。
 * 副牌首出：赢家若是本门大牌，要求本门外面没有更大的，且后面还没出牌的人没有一个已知断门（否则会毙）；
 * 赢家若已用主牌毙，要求外面没有更大的主。
 */
function winnerSecure(s: GameState, seat: Seat, plays: TrickPlay[], winnerIdx: number, unseen: Map<string, number>): boolean {
  const lead = s.trick?.lead;
  if (!lead) return false;
  const ctx = ctxOf(s);
  const d = decompose((plays[winnerIdx] as TrickPlay).cards, ctx);
  if (!d) return false;
  const top = d.components[0];
  if (!top) return false;
  if (lead.group === 'T' || d.group === 'T') return !beatable(top, 'T', unseen, ctx);
  if (beatable(top, lead.group, unseen, ctx)) return false;
  // 后面还没出的人里，有人已知断这门就可能毙
  const played = new Set(plays.map((p) => p.seat));
  const voids = knownVoids(s);
  for (let i = 0; i < s.config.players; i++) {
    if (played.has(i) || i === seat) continue;
    if (voids.get(i)?.has(lead.group)) return false;
  }
  return true;
}

function evaluateFollow(s: GameState, seat: Seat, sides: Sides, cards: Card[], f: SmartFeatures, unseen: Map<string, number> | null): number {
  const trick = s.trick as NonNullable<GameState['trick']>;
  const ctx = ctxOf(s);
  const plays: TrickPlay[] = [...trick.plays, { seat, cards }];
  const winnerIdx = trickWinner(plays, trick.lead!, ctx);
  const winner = (plays[winnerIdx] as TrickPlay).seat;
  let pts = 0;
  for (const p of plays) pts += sumPoints(p.cards);
  const remaining = s.config.players - plays.length;
  const weWin = sides.mates.has(winner);
  let score = 0;
  if (f.follow) {
    const hand = s.hands[seat] ?? [];
    const isLastTrick = hand.length === cards.length;
    const secure = remaining === 0 || (unseen !== null && winnerSecure(s, seat, plays, winnerIdx, unseen));
    // 握着朋友牌的人：打出朋友牌就亮明身份，之后全队能配合，越早越值。
    // 叫的是「第一张 A」时，庄家引牌让 A 收墩就是在找朋友，别把 A 攥着。
    // 能当庄家的朋友就尽早当：打出朋友牌收墩，越早越好，哪怕是盖过正在赢的庄家
    const revealCard = sides.likelyDealerSide && seat !== s.dealer
      && s.friendCalls.some((c) => c.resolvedSeat === null && cards.some((x) => x.suit === c.suit && x.rank === c.rank));
    if (revealCard && weWin && winner === seat) score += 6 + Math.max(0, 10 - s.tricks.length) * 0.6;
    const partner = partnerRules(s, f);
    if (weWin) {
      // 不稳的赢墩上送分要打折，自己赢比队友赢略保守
      const factor = secure ? 1 : winner === seat ? 0.55 : 0.7;
      score += pts * factor + (secure ? 4 : 2);
      if (isLastTrick) score += 45; // 末墩：闲家抠底、庄家保底
      // 四人：轮到我时对家还没出（我是第二家），对家在我后面能兜底，自己不必用大牌硬抢没分的墩
      if (partner && remaining === 2 && winner === seat && pts === 0 && !secure) score -= 3;
      // 配合：队友稳赢时，把自己手里的分牌喂上去（用分牌而不是留着）
      if (secure && winner !== seat) {
        let mine = 0;
        for (const c of cards) mine += cardPoints(c);
        score += mine * 0.6;
      }
      // 配合：队友本来就在赢，自己再用更大的牌抢过来没有意义，除非是把不稳变稳，或者是用朋友牌亮身份
      if (winner === seat && plays.length >= 2 && !revealCard) {
        const before = trickWinner(plays.slice(0, -1), trick.lead!, ctx);
        const prevWinner = (plays[before] as TrickPlay).seat;
        if (sides.mates.has(prevWinner) && prevWinner !== seat && !secure) score -= 4;
      }
    } else {
      score -= pts + 1;
      if (isLastTrick) score -= 45;
      // 四人：对手在赢、我后面还有对家（我是第三家或第二家）时，别把分牌垫出去，留给对家可能抢回的墩
      if (partner && remaining > 0) {
        let mine = 0;
        for (const c of cards) mine += cardPoints(c);
        score -= mine * smartTuning.holdPointsFactor;
      }
    }
    // 四人：上家出没分的单张或小对副牌，不杀。毙掉没分的墩是白扔主
    if (partner && !isLastTrick && pts === 0 && trick.lead && trick.lead.group !== 'T' && cards.every((c) => groupOf(c, ctx) === 'T')) score -= smartTuning.noPointRuffPenalty;
    // 四人残局前：闲家跟牌时尽量不拆稳赢的主对子，留到末墩抢底
    if (partner && !sides.likelyDealerSide && hand.length <= smartTuning.prepHand && !isLastTrick && cards.length === 1) {
      const c = cards[0] as Card;
      if (groupOf(c, ctx) === 'T' && hand.filter((h) => identityKey(h) === identityKey(c)).length >= 2
        && unseen !== null && !beatable({ kind: 'pair', cards: [c, c], top: ordinal(c, ctx), mult: 2, length: 1 } as Component, 'T', unseen, ctx)) score -= 10;
    }
  } else if (weWin) score += pts * (remaining === 0 ? 1 : winner === seat ? 0.7 : 0.85) + 3;
  else score -= pts + 1;
  // 最后一手且这墩没分，不值得用大牌
  let cost = 0;
  for (const c of cards) cost += cardCost(c, ctx);
  score -= cost * 0.12;
  // 自己赢时用的牌越贵越亏，别人赢时送出的分牌已经算在 pts 里
  return score;
}

export interface PlayCandidate {
  readonly cards: Card[];
  /** 规则打分，越高越好；搜索用它做候选排序与平局裁决 */
  readonly heuristic: number;
}

/**
 * 庄家开局先找朋友：前两墩里，只要手里还有为叫朋友留下的引牌（那门只剩不多于叫法数的非朋友牌），
 * 就把最小的一张领出去，把牌权送给握 A 的朋友；朋友现身后会根据庄家的断门把牌传回来让庄家毙。
 */
export function friendOpening(s: GameState, seat: Seat): Card[] | null {
  if (seat !== s.dealer || s.tricks.length >= 10) return null;
  if (!s.trick || s.trick.plays.length > 0) return null;
  const ctx = ctxOf(s);
  const hand = s.hands[seat] ?? [];
  // 主牌太弱时送出去的牌权拿不回来，先不急着找
  if (hand.filter((c) => groupOf(c, ctx) === 'T').length < smartTuning.openingMinTrumps) return null;
  for (const call of s.friendCalls) {
    if (call.resolvedSeat !== null) continue;
    const callsHere = s.friendCalls.filter((c) => c.suit === call.suit).length;
    const inSuit = hand.filter((c) => c.suit === call.suit && groupOf(c, ctx) !== 'T');
    // 叫的是第二张、第三张：自己手里的 A 先出掉，把序号往前推；有两张就一对一起出
    const own = inSuit.filter((c) => c.rank === call.rank);
    if (own.length > 0) return own.length >= 2 ? own.slice(0, 2) : [own[0] as Card];
    const leads = inSuit.filter((c) => c.rank !== call.rank && ordinal(c, ctx) < ordinal({ ...c, rank: call.rank }, ctx));
    if (leads.length === 0 || leads.length > callsHere) continue;
    leads.sort((a, b) => ordinal(a, ctx) - ordinal(b, ctx));
    return [leads[0] as Card];
  }
  return null;
}

/** 这手牌里是否包含能让某个朋友牌序号凑满、从而让自己成为庄家队友的牌 */
export function completesFriendCall(s: GameState, seat: Seat, cards: readonly Card[]): boolean {
  if (seat === s.dealer) return false;
  for (const call of s.friendCalls) {
    if (call.resolvedSeat !== null) continue;
    const mine = cards.filter((c) => c.suit === call.suit && c.rank === call.rank).length;
    if (mine > 0 && call.played + mine >= call.nth) return true;
  }
  return false;
}

/** 用朋友牌收下这墩（或首出朋友牌）才算「做队友的机会」；把朋友牌垫进别人赢的墩里只是白丢一张 A */
function friendChance(s: GameState, seat: Seat, cards: readonly Card[]): boolean {
  if (!completesFriendCall(s, seat, cards)) return false;
  const trick = s.trick;
  if (!trick || trick.plays.length === 0 || !trick.lead) return true;
  const plays: TrickPlay[] = [...trick.plays, { seat, cards }];
  const w = trickWinner(plays, trick.lead, ctxOf(s));
  return (plays[w] as TrickPlay).seat === seat;
}

/** 把「能成为庄家队友」的候选提到最前面，保持它们之间原有的打分顺序 */
function preferFriendPlays(s: GameState, seat: Seat, cands: PlayCandidate[]): PlayCandidate[] {
  const friend = cands.filter((c) => friendChance(s, seat, c.cards));
  if (friend.length === 0) return cands;
  const rest = cands.filter((c) => !friendChance(s, seat, c.cards));
  return [...friend.map((c) => ({ ...c, heuristic: 999 + c.heuristic / 1000 })), ...rest];
}

/** 当前轮到 seat 出牌时的候选出法，按规则打分降序。首出与跟牌都覆盖。 */
export function candidatePlays(s: GameState, seat: Seat, rng: Rng, level: SmartLevel = 2): PlayCandidate[] {
  return preferFriendPlays(s, seat, candidatePlaysInner(s, seat, rng, level));
}

function candidatePlaysInner(s: GameState, seat: Seat, rng: Rng, level: SmartLevel = 2): PlayCandidate[] {
  const f = featuresOf(level);
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  const trick = s.trick;
  const sides = sidesOf(s, seat);

  if (!trick || trick.plays.length === 0 || !trick.lead) {
    const unseen = unseenCounts(s, seat);
    const cands = leadCandidates(s, seat, sides, unseen, f).map((c) => ({ cards: c.cards, heuristic: c.score }));
    // 庄家开局找朋友：规则打分排第一（二版直接照做；搜索版把它放进候选，由推演决定）
    const opening = f.lead ? friendOpening(s, seat) : null;
    if (opening) {
      const key = opening.map((c) => c.id).join();
      const rest = cands.filter((c) => c.cards.map((x) => x.id).join() !== key);
      rest.sort((a, b) => b.heuristic - a.heuristic);
      return [{ cards: opening, heuristic: 999 }, ...rest];
    }
    cands.sort((a, b) => b.heuristic - a.heuristic);
    if (cands.length === 0 && hand[0]) cands.push({ cards: [hand[0]], heuristic: 0 });
    return cands;
  }

  const lead = trick.lead;
  const raw: Card[][] = [
    generateFollowWith(lead, hand, ctx, lowestChooser(ctx)),
    generateFollowWith(lead, hand, ctx, highestChooser(ctx)),
    generateFollowWith(lead, hand, ctx, pointsChooser(ctx)),
    ...ruffCandidates(s, seat),
  ];
  if (lead.components.length === 1 && lead.components[0]?.kind === 'pair') {
    const mine = poolOf(hand.filter((c) => groupOf(c, ctx) === lead.group), ctx);
    for (const id of mine.values()) if (id.cards.length >= 3) raw.push(id.cards.slice(0, 2));
  }
  for (let i = 0; i < 20; i++) raw.push(generateFollow(lead, hand, ctx, rng));
  const legal = dedupe(raw).filter((c) => validateFollow(lead, hand, c, ctx) === null);
  const unseen = f.follow ? unseenCounts(s, seat) : null;
  const cands = legal.map((c) => ({ cards: c, heuristic: evaluateFollow(s, seat, sides, c, f, unseen) }));
  cands.sort((a, b) => b.heuristic - a.heuristic);
  if (cands.length === 0) cands.push({ cards: generateFollow(lead, hand, ctx, rng), heuristic: 0 });
  return cands;
}

export function smartPlay(s: GameState, seat: Seat, rng: Rng, level: SmartLevel = 2): Action {
  const best = candidatePlays(s, seat, rng, level)[0] as PlayCandidate;
  return { type: 'play', seat, cards: best.cards.map((c) => c.id) };
}

export function smartAction(s: GameState, seat: Seat, rng: Rng, level: SmartLevel = 2): Action | null {
  switch (s.phase) {
    case 'bottom': return seat === s.dealer ? smartExchangeBottom(s, seat, rng) : null;
    case 'callFriend': return seat === s.dealer ? smartCallFriend(s, seat, rng, level) : null;
    case 'playing': return currentTurn(s) === seat ? smartPlay(s, seat, rng, level) : null;
    default: return null;
  }
}
