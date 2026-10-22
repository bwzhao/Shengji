/** 随机合法机器人：只保证合法，不保证聪明。用于模拟器和补位。 */
import { RANKS, SUITS, identityKey, type Card, type Suit } from './cards.ts';
import { decompose } from './combos.ts';
import { generateFollow } from './follow.ts';
import { chaodiOptions, checkDeclaration, ctxOf, currentTurn, declareLevel, GUOHE_CARDS, zaofanError, type DeclarationContext } from './reducer.ts';
import type { Rng } from './rng.ts';
import type { Action, FriendCallSpec, GameState, Seat } from './state.ts';
import { groupOf, isTrump, type Group } from './trump.ts';

export interface BotOptions {
  /** 有机会亮主时亮的概率 */
  readonly declareProbability: number;
  /** 首出时尝试甩牌的概率 */
  readonly throwProbability: number;
  /** 四人局轮到自己、手里有能抄底的对子时抄底的概率 */
  readonly chaodiProbability?: number;
  /** 能过河时过河的概率 */
  readonly guoheProbability?: number;
  /** 能造反时造反的概率 */
  readonly zaofanProbability?: number;
}

export const defaultBotOptions: BotOptions = { declareProbability: 0.5, throwProbability: 0.1, chaodiProbability: 0.3, guoheProbability: 0.5, zaofanProbability: 0.5 };

/** 手中所有可以压过当前亮主的亮法。 */
export function possibleDeclarations(s: GameState, seat: Seat): Card[][] {
  // 抢庄时（还没定庄家）各人亮自己的级牌
  return declarationCandidates(s.hands[seat] ?? [], { ...s, level: declareLevel(s, seat) }, seat);
}

/**
 * 手里所有可能的亮法（每种身份 1 到 3 张、三副牌时三张混王），再用 checkDeclaration 过滤掉不合法的。
 * 机器人和界面的一键亮主提示都用它，规则只在 checkDeclaration 一处。
 */
export function declarationCandidates(hand: readonly Card[], ctx: DeclarationContext, seat: Seat): Card[][] {
  const groups = new Map<string, Card[]>();
  for (const c of hand) {
    if (c.suit === 'J' || c.rank === ctx.level) {
      const k = identityKey(c);
      const arr = groups.get(k);
      if (arr) arr.push(c);
      else groups.set(k, [c]);
    }
  }
  const raw: Card[][] = [];
  for (const cards of groups.values()) {
    for (let n = 1; n <= Math.min(3, cards.length); n++) raw.push(cards.slice(0, n));
  }
  const jokers = hand.filter((c) => c.suit === 'J');
  if (ctx.config.decks >= 3 && jokers.length >= 3 && !raw.some((o) => o.length === 3 && (o[0] as Card).suit === 'J')) {
    raw.push(jokers.slice(0, 3));
  }
  return raw.filter((cards) => checkDeclaration(ctx, seat, cards) === null);
}

export function botDeclare(s: GameState, seat: Seat, rng: Rng, opts: BotOptions = defaultBotOptions): Action | null {
  if (s.phase !== 'dealing' && s.phase !== 'declaring') return null;
  const options = possibleDeclarations(s, seat);
  if (options.length === 0 || rng.next() >= opts.declareProbability) return null;
  return { type: 'declare', seat, cards: rng.pick(options).map((c) => c.id) };
}

/** 随机机器人抄底：有能抄的对子就按概率随便挑一对抄，否则不抄 */
function botChaodi(s: GameState, seat: Seat, rng: Rng, opts: BotOptions): Action {
  const options = chaodiOptions(s.hands[seat] ?? [], s);
  if (options.length > 0 && rng.next() < (opts.chaodiProbability ?? 0)) {
    return { type: 'chaodi', seat, cards: rng.pick(options).map((c) => c.id) };
  }
  return { type: 'passChaodi', seat };
}

/** 随机机器人过河：能过就按概率过（主牌全给，不够的随便补）；对家过河过来就随便还 5 张副牌 */
function botGuohe(s: GameState, seat: Seat, rng: Rng, opts: BotOptions): Action | null {
  const g = s.guohe;
  if (!g) return null;
  const ctx = ctxOf(s);
  const hand = s.hands[seat] ?? [];
  const trumps = hand.filter((c) => isTrump(c, ctx));
  const plain = rng.shuffle(hand.filter((c) => !isTrump(c, ctx)));
  if (g.crossings.some((c) => c.to === seat && c.returned === null)) {
    return { type: 'guoheReturn', seat, cards: [...plain, ...trumps].slice(0, GUOHE_CARDS).map((c) => c.id) };
  }
  if (!g.asked.includes(seat)) return null;
  if (rng.next() < (opts.guoheProbability ?? 0)) {
    return { type: 'guohe', seat, cards: [...trumps, ...plain].slice(0, GUOHE_CARDS).map((c) => c.id) };
  }
  return { type: 'passGuohe', seat };
}

export function botExchangeBottom(s: GameState, seat: Seat, rng: Rng): Action {
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  // 优先扣副牌里的无分单张，再随机补足
  const preferred = hand.filter((c) => groupOf(c, ctx) !== 'T' && c.rank !== 5 && c.rank !== 10 && c.rank !== 13);
  const rest = hand.filter((c) => !preferred.includes(c));
  const picked = [...rng.shuffle(preferred), ...rng.shuffle(rest)].slice(0, s.config.bottomSize);
  return { type: 'exchangeBottom', seat, cards: picked.map((c) => c.id) };
}

export function botCallFriend(s: GameState, seat: Seat, rng: Rng): Action {
  const candidates: FriendCallSpec[] = [];
  for (const suit of SUITS) {
    if (suit === s.trumpSuit) continue;
    for (const rank of RANKS) {
      if (rank === s.level) continue;
      for (let nth = 1; nth <= s.config.decks; nth++) candidates.push({ suit, rank, nth });
    }
  }
  const shuffled = rng.shuffle(candidates);
  return { type: 'callFriend', seat, calls: shuffled.slice(0, s.config.friendCount) };
}

export function botPlay(s: GameState, seat: Seat, rng: Rng, opts: BotOptions = defaultBotOptions): Action {
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  const trick = s.trick;
  if (!trick || trick.plays.length === 0 || !trick.lead) {
    const byGroup = new Map<Group, Card[]>();
    for (const c of hand) {
      const g = groupOf(c, ctx);
      const arr = byGroup.get(g);
      if (arr) arr.push(c);
      else byGroup.set(g, [c]);
    }
    const groupCards = rng.pick([...byGroup.values()]);
    const d = decompose(groupCards, ctx);
    if (!d) throw new Error('同组的牌分解失败');
    const comps = d.components;
    if (comps.length >= 2 && rng.next() < opts.throwProbability) {
      const shuffled = rng.shuffle([...comps]);
      const n = 2 + rng.int(Math.min(2, shuffled.length - 1));
      const cards = shuffled.slice(0, n).flatMap((c) => [...c.cards]);
      return { type: 'play', seat, cards: cards.map((c) => c.id) };
    }
    const comp = rng.pick(comps);
    return { type: 'play', seat, cards: comp.cards.map((c) => c.id) };
  }
  const cards = generateFollow(trick.lead, hand, ctx, rng);
  return { type: 'play', seat, cards: cards.map((c) => c.id) };
}

/** 轮到该座位时机器人要做的事；不在其回合返回 null。亮主另由 botDeclare 处理。 */
export function botAction(s: GameState, seat: Seat, rng: Rng, opts: BotOptions = defaultBotOptions): Action | null {
  switch (s.phase) {
    case 'bottom':
      if (!zaofanError(s, seat, s.hands[seat] ?? []) && rng.next() < (opts.zaofanProbability ?? 0)) return { type: 'zaofan', seat };
      return currentTurn(s) === seat ? botExchangeBottom(s, seat, rng) : null;
    case 'chaodi': return currentTurn(s) === seat ? botChaodi(s, seat, rng, opts) : null;
    case 'guohe': return botGuohe(s, seat, rng, opts);
    case 'callFriend': return seat === s.dealer ? botCallFriend(s, seat, rng) : null;
    case 'playing': return currentTurn(s) === seat ? botPlay(s, seat, rng, opts) : null;
    default: return null;
  }
}

export type { Suit };
