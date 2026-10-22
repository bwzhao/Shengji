/** 状态机：createGame 创建一局，applyAction 推进。纯函数，返回新状态与事件。 */
import { SUITS, findCards, identityKey, makeDeck, removeCards, sumPoints, type Card, type Suit } from './cards.ts';
import type { GameConfig } from './config.ts';
import { handSize } from './config.ts';
import { ruleError, type RuleError } from './errors.ts';
import { validateFollow } from './follow.ts';
import { validateLead } from './lead.ts';
import { advanceLevel, isTopLevel, levelRank } from './levels.ts';
import { createRng } from './rng.ts';
import { scoreRound } from './scoring.ts';
import type { Action, ChaodiState, Crossing, Declaration, DeclarationRecord, FriendCall, FriendCallSpec, GameEvent, GameState, Phase, RoundResult, Seat, Trick } from './state.ts';
import { bottomMultiplier, trickWinner, type TrickPlay } from './trick.ts';
import { isTrump, type TrumpCtx } from './trump.ts';
import type { Decomposition } from './combos.ts';

export type ApplyResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly GameEvent[] }
  | { readonly ok: false; readonly error: RuleError };

export interface CreateOptions {
  /** 首局从谁开始发牌，默认 0 号座位（房主） */
  readonly firstDealSeat?: Seat;
}

export function ctxOf(s: GameState): TrumpCtx {
  return { level: s.level, trumpSuit: s.trumpSuit };
}

export function nextSeat(s: GameState, seat: Seat): Seat {
  return (seat + 1) % s.config.players;
}

/**
 * 现在能行动的座位。一般就是轮到的那一个；过河是同时问的，等着还牌的对家排在前面，再是还没决定过不过河的人。
 */
export function waitingSeats(s: GameState): Seat[] {
  if (s.phase === 'guohe' && s.guohe) {
    return [...s.guohe.crossings.filter((c) => c.returned === null).map((c) => c.to), ...s.guohe.asked];
  }
  const t = currentTurn(s);
  return t === null ? [] : [t];
}

export function currentTurn(s: GameState): Seat | null {
  if (s.phase === 'bottom') return s.buryer ?? s.dealer;
  if (s.phase === 'chaodi') return s.chaodi?.queue[0] ?? null;
  if (s.phase === 'callFriend') return s.dealer;
  if (s.phase !== 'playing' || !s.trick) return null;
  const last = s.trick.plays[s.trick.plays.length - 1];
  return last ? nextSeat(s, last.seat) : s.trick.leader;
}

export function dealerTeam(s: GameState): Seat[] {
  if (s.dealer === null) return [];
  if (s.config.mode === 'partners') return [s.dealer, (s.dealer + 2) % s.config.players];
  return [s.dealer, ...s.friends];
}

export function createGame(config: GameConfig, seed: string, opts: CreateOptions = {}): GameState {
  handSize(config); // 校验牌数可整除
  const n = config.players;
  const base: GameState = {
    config,
    seed,
    round: 1,
    redeals: 0,
    phase: 'dealing',
    levels: Array.from({ length: n }, () => 0),
    dealer: null,
    level: levelRank(0, config),
    trumpSuit: null,
    trumpDecided: false,
    declaration: null,
    deck: [],
    hands: Array.from({ length: n }, () => []),
    bottom: [],
    dealTurn: opts.firstDealSeat ?? 0,
    firstDealSeat: opts.firstDealSeat ?? 0,
    friendCalls: [],
    friends: [],
    trick: null,
    tricks: [],
    captured: Array.from({ length: n }, () => 0),
    penalties: Array.from({ length: n }, () => 0),
    lastRound: null,
    winners: null,
  };
  return startDealing(base, opts.firstDealSeat ?? 0);
}

function startDealing(s: GameState, firstSeat: Seat): GameState {
  const n = s.config.players;
  const rng = createRng(`${s.seed}/${s.round}/${s.redeals}`);
  const deck = rng.shuffle(makeDeck(s.config.decks));
  return {
    ...s,
    phase: 'dealing',
    trumpSuit: null,
    trumpDecided: false,
    declaration: null,
    declarationLog: [],
    deck,
    hands: Array.from({ length: n }, () => []),
    bottom: [],
    buryer: null,
    chaodi: null,
    guohe: null,
    dealTurn: firstSeat,
    friendCalls: [],
    friends: [],
    trick: null,
    tricks: [],
    captured: Array.from({ length: n }, () => 0),
    penalties: Array.from({ length: n }, () => 0),
  };
}

function fail(code: RuleError['code'], message: string): ApplyResult {
  return { ok: false, error: ruleError(code, message) };
}

function ok(state: GameState, events: GameEvent[]): ApplyResult {
  return { ok: true, state, events };
}

function replaceAt<T>(arr: readonly T[], i: number, v: T): T[] {
  const out = [...arr];
  out[i] = v;
  return out;
}

export function applyAction(s: GameState, a: Action): ApplyResult {
  switch (a.type) {
    case 'dealCard': return dealCard(s);
    case 'declare': return declare(s, a.seat, a.cards);
    case 'closeDeclaring': return closeDeclaring(s);
    case 'exchangeBottom': return exchangeBottom(s, a.seat, a.cards);
    case 'callFriend': return callFriend(s, a.seat, a.calls);
    case 'chaodi': return chaodi(s, a.seat, a.cards);
    case 'passChaodi': return passChaodi(s, a.seat);
    case 'guohe': return guohe(s, a.seat, a.cards);
    case 'guoheReturn': return guoheReturn(s, a.seat, a.cards);
    case 'passGuohe': return passGuohe(s, a.seat);
    case 'zaofan': return zaofan(s, a.seat);
    case 'play': return play(s, a.seat, a.cards);
    case 'nextRound': return nextRound(s);
  }
}

function dealCard(s: GameState): ApplyResult {
  if (s.phase !== 'dealing') return fail('WRONG_PHASE', '现在不是发牌阶段');
  const deck = [...s.deck];
  const card = deck.pop() as Card;
  const seat = s.dealTurn;
  const hands = replaceAt(s.hands, seat, [...(s.hands[seat] as readonly Card[]), card]);
  const done = deck.length === s.config.bottomSize;
  const next: GameState = {
    ...s,
    deck: done ? [] : deck,
    bottom: done ? deck : s.bottom,
    hands,
    dealTurn: nextSeat(s, seat),
    phase: done ? 'declaring' : 'dealing',
  };
  return ok(next, [{ type: 'cardDealt', seat, card }]);
}

function declarationKindRank(cards: readonly Card[]): number {
  const c = cards[0] as Card;
  if (c.suit !== 'J') return 0;
  return c.rank === 16 ? 2 : 1;
}

/** 三张亮主的强弱：三张大王 3 > 三张小王 2 > 三张一样的级牌 1 > 三张不一样的王 0 */
export const TOP_TRIPLE_TIER = 3;
export function tripleDeclarationTier(cards: readonly Card[]): number {
  const first = cards[0] as Card;
  if (first.suit !== 'J') return 1;
  if (!cards.every((c) => identityKey(c) === identityKey(first))) return 0;
  return first.rank === 16 ? 3 : 2;
}

/**
 * seat 亮主要用的级牌点数。还没定庄家（抢庄）时用自己的等级：首局大家都一样；
 * 非首局底牌翻不出常主后重新抢庄，谁先亮出自己的级牌谁坐庄。定了庄家就用这一局的级牌。
 */
export function declareLevel(s: Pick<GameState, 'dealer' | 'level' | 'levels' | 'config'>, seat: Seat): number {
  return s.dealer === null ? levelRank(s.levels[seat] ?? 0, s.config) : s.level;
}

/** 亮主合法性的输入：服务端用完整局面，客户端用 PlayerView，两边都有这三项 */
export interface DeclarationContext {
  readonly config: GameConfig;
  readonly level: number;
  readonly declaration: Declaration | null;
}

/**
 * 检查 seat 亮出 cards 是否合法（不检查牌是否在手里）。服务端、机器人、界面提示共用这一份规则。
 * - 级牌一到三张同一张牌，或两三张同样的王；三副牌里三张王可以大小混
 * - 反别人的主：张数更多；四人模式同张数时一对王盖一对级牌、一对大王盖一对小王；
 *   同是三张时三张大王 > 三张小王 > 三张一样的级牌 > 三张不一样的王
 * - 自己已经亮着主、没人反过时：只能用更多张同样的牌加固，不能改亮别的花色或改亮王
 */
export function checkDeclaration(ctx: DeclarationContext, seat: Seat, cards: readonly Card[]): RuleError | null {
  if (cards.length === 0) return ruleError('INVALID_DECLARATION', '没有选牌');
  if (cards.length > 3) return ruleError('INVALID_DECLARATION', '最多亮三张');
  const first = cards[0] as Card;
  const allJokers = cards.every((c) => c.suit === 'J');
  const mixedTripleJokers = allJokers && cards.length === 3 && ctx.config.decks >= 3;
  if (!mixedTripleJokers && !cards.every((c) => identityKey(c) === identityKey(first))) {
    return ruleError('INVALID_DECLARATION', '亮主的牌必须是同一张牌的多张，三张王可以混');
  }
  if (first.suit === 'J') {
    if (cards.length < 2) return ruleError('INVALID_DECLARATION', '单张王不能亮主');
  } else if (first.rank !== ctx.level) {
    return ruleError('INVALID_DECLARATION', `只能用级牌亮主，当前级牌是 ${ctx.level}`);
  }
  const suit: Suit | null = first.suit === 'J' ? null : (first.suit as Suit);
  const current = ctx.declaration;
  if (!current) return null;
  const count = cards.length;
  if (current.seat === seat) {
    // 自己亮的主还有效：只能加固，不能换
    if (suit !== current.suit) return ruleError('INVALID_DECLARATION', '你已经亮了主，只能用更多张同样的牌加固，不能改亮别的花色');
    if (count <= current.count) return ruleError('DECLARATION_TOO_WEAK', '加固要比现在亮的张数多');
    return null;
  }
  if (count < current.count) return ruleError('DECLARATION_TOO_WEAK', `已有人亮了 ${current.count} 张，要反主必须更多张`);
  if (count === 3 && current.count === 3) {
    if (tripleDeclarationTier(cards) <= tripleDeclarationTier(current.cards)) {
      return ruleError('DECLARATION_TOO_WEAK', '同是三张，只能用更大的三张反主：三张大王 > 三张小王 > 三张一样的级牌 > 三张不一样的王');
    }
  } else if (count === current.count) {
    if (!ctx.config.allowEqualCountOverride) return ruleError('DECLARATION_TOO_WEAK', '张数相同不能反主');
    if (declarationKindRank(cards) <= declarationKindRank(current.cards)) {
      return ruleError('DECLARATION_TOO_WEAK', '同张数只能用更大的王反主');
    }
  }
  return null;
}

function declare(s: GameState, seat: Seat, ids: readonly string[]): ApplyResult {
  if (s.phase !== 'dealing' && s.phase !== 'declaring') return fail('WRONG_PHASE', '现在不能亮主');
  const hand = s.hands[seat];
  if (!hand) return fail('INVALID_ACTION', '座位不存在');
  const cards = findCards(hand, ids);
  if (!cards || cards.length === 0) return fail('CARDS_NOT_IN_HAND', '亮出的牌不在手中');
  const level = declareLevel(s, seat);
  const err = checkDeclaration({ ...s, level }, seat, cards);
  if (err) return { ok: false, error: err };
  const first = cards[0] as Card;
  const suit: Suit | null = first.suit === 'J' ? null : (first.suit as Suit);
  const count = cards.length;
  const kind = !s.declaration ? 'declare' : s.declaration.seat === seat ? 'reinforce' : 'override';
  const next: GameState = {
    ...s,
    declaration: { seat, cards, suit, count },
    declarationLog: [...(s.declarationLog ?? []), { kind, seat, cards, suit }],
    trumpSuit: suit,
    trumpDecided: true,
    // 首局谁最终抢到主谁坐庄：被反主则庄家随之改变。非首局庄家已定，反主只改主花色；
    // 非首局重新抢庄时谁先亮谁坐庄，这一局打他的级，之后反主只改主花色
    // 造反后重新抢庄也是谁先亮谁坐庄，首局也一样
    dealer: s.round === 1 && !s.grabFixed ? seat : (s.dealer ?? seat),
    level: s.dealer === null ? level : s.level,
  };
  return ok(next, [{ type: 'declared', seat, cards, suit, count }]);
}

function closeDeclaring(s: GameState): ApplyResult {
  if (s.phase !== 'declaring') return fail('WRONG_PHASE', '发牌还没结束');
  const events: GameEvent[] = [];
  let next = s;
  if (!s.declaration) {
    if (s.dealer === null) {
      // 抢庄时没人亮（首局，或非首局重新抢庄）：重新发牌再抢
      if (!s.config.redealIfNoDeclarerFirstRound) return fail('INVALID_ACTION', '首局无人亮主且未配置重发');
      // 发牌轮数是人数的整数倍，此时 dealTurn 已回到这一轮发牌的起点
      next = startDealing({ ...s, redeals: s.redeals + 1 }, s.dealTurn);
      return ok(next, [{ type: 'redeal' }]);
    }
    // 非首局无人亮主：底牌一张张翻开给所有人看，翻到第一张常主（级牌或王）为止，级牌定它的花色，王打无主
    const order = [...s.bottom].reverse();
    const at = order.findIndex((c) => c.suit === 'J' || c.rank === s.level);
    if (at < 0) {
      // 底牌里没有常主：重新发牌抢庄，谁先亮出自己的级牌谁坐庄
      next = startDealing({ ...s, dealer: null, redeals: s.redeals + 1 }, nextSeat(s, s.dealer));
      return ok(next, [{ type: 'regrab', flipped: order }]);
    }
    const flipped = order.slice(0, at + 1);
    const card = flipped[at] as Card;
    const trumpSuit = card.suit === 'J' ? null : (card.suit as Suit);
    next = { ...s, trumpSuit, trumpDecided: true, declarationLog: [...(s.declarationLog ?? []), { kind: 'bottom', card, suit: trumpSuit, flipped }] };
    events.push({ type: 'declaringClosed', trumpSuit, byBottom: true, flipped });
  } else {
    events.push({ type: 'declaringClosed', trumpSuit: s.trumpSuit, byBottom: false });
  }
  const dealer = next.dealer as Seat;
  const hands = replaceAt(next.hands, dealer, [...(next.hands[dealer] as readonly Card[]), ...next.bottom]);
  next = { ...next, hands, bottom: [], phase: 'bottom' };
  events.push({ type: 'bottomTaken', seat: dealer, count: s.bottom.length });
  return ok(next, events);
}

function exchangeBottom(s: GameState, seat: Seat, ids: readonly string[]): ApplyResult {
  if (s.phase !== 'bottom') return fail('WRONG_PHASE', '现在不是扣底阶段');
  if (seat !== (s.buryer ?? s.dealer)) return fail('NOT_DEALER', s.buryer != null ? '现在是抄底的人在埋底' : '只有庄家能扣底');
  const hand = s.hands[seat] as readonly Card[];
  const cards = findCards(hand, ids);
  if (!cards) return fail('CARDS_NOT_IN_HAND', '扣的牌不在手中');
  if (cards.length !== s.config.bottomSize) {
    return fail('WRONG_CARD_COUNT', `必须扣 ${s.config.bottomSize} 张`);
  }
  const next: GameState = {
    ...s,
    hands: replaceAt(s.hands, seat, removeCards(hand, cards)),
    bottom: cards,
    buryer: seat,
  };
  const events: GameEvent[] = [{ type: 'bottomExchanged', seat }];
  if (s.config.friendCount > 0) return ok({ ...next, phase: 'callFriend' }, events);
  // 四人升级：翻底定主的那一局不抄底；能抄底就依次问，否则扣完底直接开打
  const byBottom = (s.declarationLog ?? []).some((e) => e.kind === 'bottom');
  if (s.config.chaodi && !byBottom) return ok(askChaodi(next, seat), events);
  return ok(afterBottom(next), events);
}

/** 对家模式开打：庄家先出 */
function startPlaying(s: GameState): GameState {
  return { ...s, phase: 'playing', chaodi: null, trick: { leader: s.dealer as Seat, plays: [], lead: null } };
}

/** 抄底比大小：大王 > 小王 > ♠ > ♥ > ♣ > ♦ */
const CHAODI_RANK: Record<string, number> = { D: 1, C: 2, H: 3, S: 4 };
export function chaodiRank(cards: readonly Card[]): number {
  const c = cards[0] as Card;
  if (c.suit === 'J') return c.rank === 16 ? 6 : 5;
  return CHAODI_RANK[c.suit] ?? 0;
}
const TOP_CHAODI_RANK = 6;

/** 抄底合法性的输入：服务端用完整局面，客户端用 PlayerView */
export interface ChaodiContext {
  readonly level: number;
  readonly declaration?: Declaration | null;
  readonly chaodi?: ChaodiState | null;
}

/** 抄底要压过的那一对：上一次抄底的对子，或亮主时亮出的一对；亮的是单张就不受限制 */
function chaodiTarget(ctx: ChaodiContext): readonly Card[] | null {
  const last = ctx.chaodi?.last;
  if (last) return last.cards;
  return ctx.declaration?.count === 2 ? ctx.declaration.cards : null;
}

/**
 * 检查用 cards 抄底是否合法（不检查牌是否在手里）：必须是一对常主——两张一样的级牌或两张一样的王；
 * 亮主是单张时第一次抄底任意一对都行，否则要比当前亮出的那一对大。
 */
export function checkChaodi(ctx: ChaodiContext, cards: readonly Card[]): RuleError | null {
  if (cards.length !== 2) return ruleError('INVALID_DECLARATION', '抄底要用一对常主（两张一样的级牌或王）');
  const [a, b] = cards as [Card, Card];
  if (identityKey(a) !== identityKey(b)) return ruleError('INVALID_DECLARATION', '抄底的两张牌必须一样');
  if (a.suit !== 'J' && a.rank !== ctx.level) return ruleError('INVALID_DECLARATION', `只能用一对级牌或一对王抄底，当前级牌是 ${ctx.level}`);
  const target = chaodiTarget(ctx);
  if (target && chaodiRank(cards) <= chaodiRank(target)) {
    return ruleError('DECLARATION_TOO_WEAK', '要比当前亮出的那对大：大王 > 小王 > ♠ > ♥ > ♣ > ♦');
  }
  return null;
}

/** 手里能用来抄底的每一种对子（每种取两张），界面和机器人共用 */
export function chaodiOptions(hand: readonly Card[], ctx: ChaodiContext): Card[][] {
  const groups = new Map<string, Card[]>();
  for (const c of hand) {
    if (c.suit !== 'J' && c.rank !== ctx.level) continue;
    const k = identityKey(c);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const out: Card[][] = [];
  for (const g of groups.values()) if (g.length >= 2 && !checkChaodi(ctx, g.slice(0, 2))) out.push(g.slice(0, 2));
  return out.sort((x, y) => chaodiRank(y) - chaodiRank(x));
}

/**
 * 埋完底后依次问要不要抄底：从刚埋底的人的下家开始问一圈。刚埋底的人不能接着抄，
 * 定了当前主花色的人（亮主的人，或上一个抄底的人）也不能抄。亮出的是一对大王就不再问。没人可问就开打。
 */
function askChaodi(s: GameState, buryer: Seat): GameState {
  const last = s.chaodi?.last ?? null;
  const setter = last?.seat ?? s.declaration?.seat ?? null;
  const target = chaodiTarget(s);
  const queue: Seat[] = [];
  if (!target || chaodiRank(target) < TOP_CHAODI_RANK) {
    for (let k = 1; k < s.config.players; k++) {
      const seat = (buryer + k) % s.config.players;
      if (seat !== setter) queue.push(seat);
    }
  }
  if (queue.length === 0) return afterBottom(s);
  return { ...s, phase: 'chaodi', chaodi: { queue, last } };
}

function chaodi(s: GameState, seat: Seat, ids: readonly string[]): ApplyResult {
  if (s.phase !== 'chaodi' || !s.chaodi) return fail('WRONG_PHASE', '现在不能抄底');
  if (s.chaodi.queue[0] !== seat) return fail('NOT_YOUR_TURN', '还没轮到你决定抄不抄底');
  const hand = s.hands[seat] as readonly Card[];
  const cards = findCards(hand, ids);
  if (!cards) return fail('CARDS_NOT_IN_HAND', '抄底的牌不在手中');
  const err = checkChaodi(s, cards);
  if (err) return { ok: false, error: err };
  const first = cards[0] as Card;
  const suit: Suit | null = first.suit === 'J' ? null : (first.suit as Suit);
  // 拿起底牌重新埋；庄家不变，保底的责任还在庄家
  const next: GameState = {
    ...s,
    hands: replaceAt(s.hands, seat, [...hand, ...s.bottom]),
    bottom: [],
    buryer: seat,
    phase: 'bottom',
    trumpSuit: suit,
    declaration: { seat, cards, suit, count: cards.length },
    declarationLog: [...(s.declarationLog ?? []), { kind: 'chaodi', seat, cards, suit }],
    chaodi: { queue: [], last: { seat, cards } },
  };
  return ok(next, [{ type: 'chaodi', seat, cards, suit }, { type: 'bottomTaken', seat, count: s.bottom.length }]);
}

function passChaodi(s: GameState, seat: Seat): ApplyResult {
  if (s.phase !== 'chaodi' || !s.chaodi) return fail('WRONG_PHASE', '现在不是抄底阶段');
  if (s.chaodi.queue[0] !== seat) return fail('NOT_YOUR_TURN', '还没轮到你决定抄不抄底');
  const queue = s.chaodi.queue.slice(1);
  const next: GameState = queue.length > 0 ? { ...s, chaodi: { ...s.chaodi, queue } } : afterBottom(s);
  return ok(next, [{ type: 'chaodiPassed', seat }]);
}

// ---------- 造反（GitHub issue #13） ----------

/** 造反合法性的输入：服务端用完整局面，客户端用 PlayerView */
export interface ZaofanContext {
  readonly config: GameConfig;
  readonly phase: Phase;
  readonly dealer: Seat | null;
  readonly declarationLog?: readonly DeclarationRecord[];
}

/**
 * 能不能造反（hand 是这个座位现在的手牌）：庄家第一次埋底时（四人抄底开始前）或叫朋友时，
 * 手里 5、10、K 的分数不多于下限或不少于上限。庄家只能在埋底前造反，手里含底牌，用更高的上限。
 */
export function zaofanError(ctx: ZaofanContext, seat: Seat, hand: readonly Card[]): RuleError | null {
  const rule = ctx.config.zaofan;
  if (!rule) return ruleError('INVALID_ZAOFAN', '这个模式不能造反');
  const firstBury = ctx.phase === 'bottom' && !(ctx.declarationLog ?? []).some((e) => e.kind === 'chaodi');
  if (!firstBury && ctx.phase !== 'callFriend') return ruleError('WRONG_PHASE', '只能在庄家埋底或叫朋友时造反');
  if (seat === ctx.dealer && !firstBury) return ruleError('WRONG_PHASE', '庄家只能在埋底前造反');
  const points = sumPoints(hand);
  const high = seat === ctx.dealer ? rule.dealerHigh : rule.high;
  if (points > rule.low && points < high) {
    return ruleError('INVALID_ZAOFAN', `手里 ${points} 分；不多于 ${rule.low} 分或不少于 ${high} 分才能造反`);
  }
  return null;
}

/** 造反：推倒重来，从造反的人开始重新发牌抢庄，谁先亮出自己的级牌谁坐庄，之后反主只改主花色 */
function zaofan(s: GameState, seat: Seat): ApplyResult {
  const hand = s.hands[seat] as readonly Card[];
  const err = zaofanError(s, seat, hand);
  if (err) return { ok: false, error: err };
  const next = startDealing({ ...s, dealer: null, grabFixed: true, redeals: s.redeals + 1 }, seat);
  return ok(next, [{ type: 'zaofan', seat, points: sumPoints(hand) }]);
}

// ---------- 四人过河（GitHub issue #7） ----------

/** 过河交换的张数，也是能过河的主牌张数上限 */
export const GUOHE_CARDS = 5;

/**
 * 抄底问完（或这局不抄底）后同时问能过河的人：主牌不多于 5 张，不是庄家，本局没抄过底。
 * 打无主不过河；没人能过就开打。
 */
function afterBottom(s: GameState): GameState {
  if (!s.config.guohe || s.trumpSuit === null) return startPlaying(s);
  const ctx = ctxOf(s);
  const chaodiSeats = new Set((s.declarationLog ?? []).flatMap((e) => (e.kind === 'chaodi' ? [e.seat] : [])));
  const asked: Seat[] = [];
  for (let seat = 0; seat < s.config.players; seat++) {
    if (seat === s.dealer || chaodiSeats.has(seat)) continue;
    if ((s.hands[seat] ?? []).filter((c) => isTrump(c, ctx)).length <= GUOHE_CARDS) asked.push(seat);
  }
  if (asked.length === 0) return startPlaying(s);
  return { ...s, phase: 'guohe', chaodi: null, guohe: { asked, crossings: [] } };
}

/** 过河给出的牌（不检查是否在手里）：正好 5 张，手里的主牌必须全在里面，不够的用别的牌补 */
export function checkGuoheGive(hand: readonly Card[], cards: readonly Card[], ctx: TrumpCtx): RuleError | null {
  if (cards.length !== GUOHE_CARDS) return ruleError('WRONG_CARD_COUNT', `过河要给对家 ${GUOHE_CARDS} 张牌`);
  const ids = new Set(cards.map((c) => c.id));
  if (hand.some((c) => isTrump(c, ctx) && !ids.has(c.id))) return ruleError('INVALID_GUOHE', '过河要把手里的主牌全部给出去');
  return null;
}

/** 还牌（不检查是否在手里）：正好 5 张副牌；副牌不够 5 张时副牌全还，差的用主牌补 */
export function checkGuoheReturn(hand: readonly Card[], cards: readonly Card[], ctx: TrumpCtx): RuleError | null {
  if (cards.length !== GUOHE_CARDS) return ruleError('WRONG_CARD_COUNT', `要还给对家 ${GUOHE_CARDS} 张牌`);
  const plain = hand.filter((c) => !isTrump(c, ctx));
  const ids = new Set(cards.map((c) => c.id));
  const fine = plain.length >= GUOHE_CARDS ? cards.every((c) => !isTrump(c, ctx)) : plain.every((c) => ids.has(c.id));
  return fine ? null : ruleError('INVALID_GUOHE', '还牌只能还副牌，不能还主牌');
}

/** 四人对家：坐对面的人 */
function partnerOf(s: GameState, seat: Seat): Seat {
  return (seat + s.config.players / 2) % s.config.players;
}

function guohe(s: GameState, seat: Seat, ids: readonly string[]): ApplyResult {
  if (s.phase !== 'guohe' || !s.guohe) return fail('WRONG_PHASE', '现在不是过河阶段');
  if (!s.guohe.asked.includes(seat)) return fail('NOT_YOUR_TURN', '你现在不能过河');
  const hand = s.hands[seat] as readonly Card[];
  const cards = findCards(hand, ids);
  if (!cards) return fail('CARDS_NOT_IN_HAND', '过河的牌不在手中');
  const err = checkGuoheGive(hand, cards, ctxOf(s));
  if (err) return { ok: false, error: err };
  const to = partnerOf(s, seat);
  let hands = replaceAt(s.hands, seat, removeCards(hand, cards));
  hands = replaceAt(hands, to, [...(hands[to] as readonly Card[]), ...cards]);
  // 一队只过一次：对家已经拿到全队的主，不再问他
  const asked = s.guohe.asked.filter((x) => x !== seat && x !== to);
  const crossings: Crossing[] = [...s.guohe.crossings, { from: seat, to, given: cards, returned: null }];
  return ok({ ...s, hands, guohe: { asked, crossings } }, [{ type: 'guohe', seat, to }]);
}

function guoheReturn(s: GameState, seat: Seat, ids: readonly string[]): ApplyResult {
  if (s.phase !== 'guohe' || !s.guohe) return fail('WRONG_PHASE', '现在不是过河阶段');
  const k = s.guohe.crossings.findIndex((c) => c.to === seat && c.returned === null);
  if (k < 0) return fail('NOT_YOUR_TURN', '没有人过河给你');
  const crossing = s.guohe.crossings[k] as Crossing;
  const hand = s.hands[seat] as readonly Card[];
  const cards = findCards(hand, ids);
  if (!cards) return fail('CARDS_NOT_IN_HAND', '还的牌不在手中');
  const err = checkGuoheReturn(hand, cards, ctxOf(s));
  if (err) return { ok: false, error: err };
  let hands = replaceAt(s.hands, seat, removeCards(hand, cards));
  hands = replaceAt(hands, crossing.from, [...(hands[crossing.from] as readonly Card[]), ...cards]);
  const crossings = s.guohe.crossings.map((c, i) => (i === k ? { ...c, returned: cards } : c));
  return ok(guoheProgress({ ...s, hands, guohe: { ...s.guohe, crossings } }), [{ type: 'guoheReturned', seat, to: crossing.from }]);
}

function passGuohe(s: GameState, seat: Seat): ApplyResult {
  if (s.phase !== 'guohe' || !s.guohe) return fail('WRONG_PHASE', '现在不是过河阶段');
  if (!s.guohe.asked.includes(seat)) return fail('NOT_YOUR_TURN', '你现在不用决定过不过河');
  const asked = s.guohe.asked.filter((x) => x !== seat);
  return ok(guoheProgress({ ...s, guohe: { ...s.guohe, asked } }), [{ type: 'guohePassed', seat }]);
}

/** 人人都决定了、过河的牌也都还了就开打；过河记录留到本局结束 */
function guoheProgress(s: GameState): GameState {
  const g = s.guohe;
  if (!g || g.asked.length > 0 || g.crossings.some((c) => c.returned === null)) return s;
  return startPlaying(s);
}

function callFriend(s: GameState, seat: Seat, calls: readonly FriendCallSpec[]): ApplyResult {
  if (s.phase !== 'callFriend') return fail('WRONG_PHASE', '现在不是叫朋友阶段');
  if (seat !== s.dealer) return fail('NOT_DEALER', '只有庄家能叫朋友');
  if (calls.length !== s.config.friendCount) {
    return fail('INVALID_FRIEND_CALL', `必须叫 ${s.config.friendCount} 个朋友`);
  }
  const seen = new Set<string>();
  for (const c of calls) {
    if (!SUITS.includes(c.suit)) return fail('INVALID_FRIEND_CALL', '朋友牌花色无效');
    if (c.suit === s.trumpSuit) return fail('INVALID_FRIEND_CALL', '朋友牌不能是主花色');
    if (!Number.isInteger(c.rank) || c.rank < 2 || c.rank > 14) return fail('INVALID_FRIEND_CALL', '朋友牌点数无效');
    if (c.rank === s.level) return fail('INVALID_FRIEND_CALL', '朋友牌不能是级牌');
    if (!Number.isInteger(c.nth) || c.nth < 1 || c.nth > s.config.decks) {
      return fail('INVALID_FRIEND_CALL', `序号必须在 1 到 ${s.config.decks} 之间`);
    }
    const key = `${c.suit}${c.rank}#${c.nth}`;
    if (seen.has(key)) return fail('INVALID_FRIEND_CALL', '两个朋友牌不能完全相同');
    seen.add(key);
  }
  const friendCalls: FriendCall[] = calls.map((c) => ({ ...c, played: 0, resolvedSeat: null }));
  const next: GameState = {
    ...s,
    friendCalls,
    phase: 'playing',
    trick: { leader: seat, plays: [], lead: null },
  };
  return ok(next, [{ type: 'friendCalled', calls }]);
}

function play(s: GameState, seat: Seat, ids: readonly string[]): ApplyResult {
  if (s.phase !== 'playing' || !s.trick) return fail('WRONG_PHASE', '现在不是出牌阶段');
  const turn = currentTurn(s);
  if (turn !== seat) return fail('NOT_YOUR_TURN', '还没轮到你出牌');
  const hand = s.hands[seat] as readonly Card[];
  const cards = findCards(hand, ids);
  if (!cards || cards.length === 0) return fail('CARDS_NOT_IN_HAND', '出的牌不在手中');
  const ctx = ctxOf(s);
  const events: GameEvent[] = [];
  let actual: readonly Card[] = cards;
  let lead: Decomposition | null = s.trick.lead;
  let penalties = s.penalties;

  if (s.trick.plays.length === 0) {
    const others = s.hands.filter((_, i) => i !== seat);
    const outcome = validateLead(cards, others, ctx, s.config.throwPenaltyPerCard);
    if ('code' in outcome) return { ok: false, error: outcome };
    lead = outcome.effective;
    if (outcome.forced) {
      actual = outcome.forced.cards;
      penalties = replaceAt(penalties, seat, (penalties[seat] as number) + outcome.penalty);
      events.push({ type: 'throwFailed', seat, attempted: cards, forced: actual, penalty: outcome.penalty });
    }
  } else {
    const err = validateFollow(lead as Decomposition, hand, cards, ctx);
    if (err) return { ok: false, error: err };
  }

  const plays: TrickPlay[] = [...s.trick.plays, { seat, cards: actual }];
  events.push({ type: 'cardsPlayed', seat, cards: actual });

  // 朋友牌计数
  let friendCalls = s.friendCalls;
  let friends = s.friends;
  for (const c of actual) {
    if (c.suit === 'J') continue;
    friendCalls = friendCalls.map((fc) => {
      if (fc.resolvedSeat !== null || fc.suit !== c.suit || fc.rank !== c.rank) return fc;
      if (seat === s.dealer && !s.config.dealerCountsForFriend) return fc;
      const played = fc.played + 1;
      if (played === fc.nth) {
        events.push({ type: 'friendRevealed', seat, call: { suit: fc.suit, rank: fc.rank, nth: fc.nth } });
        if (seat !== s.dealer && !friends.includes(seat)) friends = [...friends, seat];
        return { ...fc, played, resolvedSeat: seat };
      }
      return { ...fc, played };
    });
  }

  let next: GameState = {
    ...s,
    hands: replaceAt(s.hands, seat, removeCards(hand, actual)),
    trick: { ...s.trick, plays, lead },
    friendCalls,
    friends,
    penalties,
  };

  if (plays.length < s.config.players) return ok(next, events);

  const winnerIdx = trickWinner(plays, lead as Decomposition, ctx);
  const winner = (plays[winnerIdx] as TrickPlay).seat;
  let points = 0;
  for (const p of plays) points += sumPoints(p.cards);
  next = {
    ...next,
    captured: replaceAt(next.captured, winner, (next.captured[winner] as number) + points),
    tricks: [...next.tricks, { leader: s.trick.leader, winner, plays, points }],
  };
  events.push({ type: 'trickWon', winner, points });

  const roundOver = next.hands.every((h) => h.length === 0);
  if (!roundOver) {
    const trick: Trick = { leader: winner, plays: [], lead: null };
    return ok({ ...next, trick }, events);
  }
  return endRound({ ...next, trick: null }, winner, lead as Decomposition, events);
}

function endRound(s: GameState, lastWinner: Seat, lastLead: Decomposition, events: GameEvent[]): ApplyResult {
  const dealer = s.dealer as Seat;
  const team = dealerTeam(s);
  const opponents: Seat[] = [];
  for (let i = 0; i < s.config.players; i++) if (!team.includes(i)) opponents.push(i);

  let capturedByOpponents = 0;
  for (const o of opponents) capturedByOpponents += s.captured[o] as number;
  const bottomPoints = sumPoints(s.bottom);
  const mult = bottomMultiplier(lastLead);
  const bottomBonus = opponents.includes(lastWinner) ? bottomPoints * mult : 0;
  let penaltyDelta = 0;
  for (const t of team) penaltyDelta += s.penalties[t] as number;
  for (const o of opponents) penaltyDelta -= s.penalties[o] as number;
  const opponentPoints = Math.max(0, capturedByOpponents + bottomBonus + penaltyDelta);

  const { dealerHeld, levelsUp } = scoreRound(opponentPoints, s.config);
  const winnersTeam = dealerHeld ? team : opponents;
  // 庄家在 A 上守住才算赢下整局（四人升级：打过 A 必须在庄上赢）
  const gameOver = dealerHeld && isTopLevel(s.levels[dealer] as number, s.config);
  const levelsBefore = [...s.levels];
  let levels = [...s.levels];
  if (!gameOver) {
    // 5、10、K 要庄上过：闲家上台时停在这几级的人只上庄、不升级
    for (const w of winnersTeam) levels[w] = advanceLevel(levels[w] as number, levelsUp, s.config, dealerHeld);
  }

  let nextDealer = dealer;
  if (!(dealerHeld && s.config.dealerKeepsOnHold)) for (let k = 1; k < s.config.players; k++) {
    const cand = (dealer + k) % s.config.players;
    if (winnersTeam.includes(cand)) { nextDealer = cand; break; }
  }

  const result: RoundResult = {
    round: s.round,
    dealer,
    dealerTeam: team,
    opponents,
    capturedByOpponents,
    bottomCards: s.bottom,
    bottomPoints,
    bottomMultiplier: mult,
    bottomBonus,
    penaltyDelta,
    opponentPoints,
    dealerHeld,
    levelsUp,
    levelsBefore,
    levelsAfter: levels,
    nextDealer,
    gameOver,
  };
  events.push({ type: 'roundScored', result });
  const next: GameState = {
    ...s,
    levels,
    lastRound: result,
    phase: gameOver ? 'gameOver' : 'roundEnd',
    winners: gameOver ? team : null,
  };
  if (gameOver) events.push({ type: 'gameOver', winners: team });
  return ok(next, events);
}

/**
 * 房主重发本局：等级、局数、庄家（非首局）都保留，当前进度作废，换一副新牌重新发。
 * 首局重发时庄家也清空，仍由先亮主者坐庄。
 */
export function restartRound(s: GameState): { state: GameState; events: GameEvent[] } {
  if (s.phase === 'gameOver') return { state: s, events: [] };
  const firstRound = s.round === 1;
  // 首局重发时庄家清空；非首局重新抢庄中（还没定庄家）重发，照样接着抢
  const dealer = firstRound ? null : s.dealer;
  const base: GameState = {
    ...s,
    dealer,
    level: dealer === null ? (firstRound ? levelRank(0, s.config) : s.level) : levelRank(s.levels[dealer] as number, s.config),
    redeals: s.redeals + 1,
    winners: null,
  };
  const start = dealer === null ? (s.firstDealSeat ?? 0) : nextSeat(s, dealer);
  return { state: startDealing(base, start), events: [{ type: 'roundRestarted' }] };
}

function nextRound(s: GameState): ApplyResult {
  if (s.phase !== 'roundEnd' || !s.lastRound) return fail('WRONG_PHASE', '本局还没结束');
  const dealer = s.lastRound.nextDealer;
  const base: GameState = {
    ...s,
    round: s.round + 1,
    redeals: 0,
    grabFixed: false,
    dealer,
    level: levelRank(s.levels[dealer] as number, s.config),
  };
  const next = startDealing(base, nextSeat(s, dealer));
  return ok(next, [{ type: 'dealerChanged', dealer }]);
}
