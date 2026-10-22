/** 每个座位能看到的信息。服务端只把 PlayerView 发给客户端。 */
import { cardPoints, type Card, type Suit } from './cards.ts';
import type { GameConfig } from './config.ts';
import type { LevelIndex } from './levels.ts';
import { currentTurn, dealerTeam, declareLevel } from './reducer.ts';
import type { ChaodiState, Declaration, DeclarationRecord, FriendCall, GameState, Phase, RoundResult, Seat, Trick, TrickRecord } from './state.ts';
import { sortCards, suitDisplayOrder } from './trump.ts';

export interface PlayerView {
  readonly seat: Seat;
  readonly config: GameConfig;
  readonly round: number;
  readonly phase: Phase;
  readonly levels: readonly LevelIndex[];
  readonly dealer: Seat | null;
  readonly level: number;
  readonly trumpSuit: Suit | null;
  readonly trumpDecided: boolean;
  readonly declaration: Declaration | null;
  /** 本局亮主、加固、反主、翻底的全部记录（都是公开信息） */
  readonly declarationLog: readonly DeclarationRecord[];
  readonly hand: readonly Card[];
  readonly handCounts: readonly number[];
  readonly bottomCount: number;
  /** 庄家从扣底起一直能看到（扣底阶段是还没扣的空底，之后是自己扣下的牌）；结算时所有人能看到 */
  readonly bottom: readonly Card[] | null;
  /** 最后埋底的人（正在埋底的人）：庄家，或抄底的人。只有他能看底 */
  readonly buryer: Seat | null;
  /** 四人抄底的进度（大家都看得到）：这一圈还要问谁、上一次抄底用的一对牌 */
  readonly chaodi: ChaodiState | null;
  readonly deckRemaining: number;
  readonly friendCalls: readonly FriendCall[];
  readonly dealerTeam: readonly Seat[];
  /** 朋友全部揭晓后才能确定的闲家 */
  readonly knownOpponents: readonly Seat[];
  readonly trick: Trick | null;
  /** 上一墩，供客户端在新一墩开始前短暂展示收墩 */
  readonly lastTrick: TrickRecord | null;
  /** 本局打完的每一墩，供「出牌记录」翻看；出过的牌所有人都看得到 */
  readonly tricks: readonly TrickRecord[];
  readonly trickNo: number;
  readonly captured: readonly number[];
  /** 已确认的闲家抓到的分；身份未定的人抓的分暂不计入 */
  readonly visibleOpponentPoints: number;
  /** 身份未定的人抓到的分，等朋友全部现身后再归入闲家或庄家 */
  readonly pendingPoints: number;
  /** 已确认闲家抓到的分牌 */
  readonly opponentPointCards: readonly Card[];
  /** 身份未定的人抓到的分牌 */
  readonly pendingPointCards: readonly Card[];
  readonly penalties: readonly number[];
  readonly currentTurn: Seat | null;
  readonly lastRound: RoundResult | null;
  readonly winners: readonly Seat[] | null;
}

export function viewFor(s: GameState, seat: Seat): PlayerView {
  const team = dealerTeam(s);
  const allFriendsKnown = s.dealer !== null
    && (s.config.friendCount === 0 || (s.friendCalls.length > 0 && s.friendCalls.every((c) => c.resolvedSeat !== null)));
  const knownOpponents: Seat[] = [];
  if (allFriendsKnown || s.phase === 'roundEnd' || s.phase === 'gameOver') {
    for (let i = 0; i < s.config.players; i++) if (!team.includes(i)) knownOpponents.push(i);
  }
  let visibleOpponentPoints = 0;
  let pendingPoints = 0;
  const opponentSet = new Set(knownOpponents);
  for (let i = 0; i < s.config.players; i++) {
    if (team.includes(i)) continue;
    if (opponentSet.has(i)) visibleOpponentPoints += s.captured[i] as number;
    else pendingPoints += s.captured[i] as number;
  }
  const opponentPointCards: Card[] = [];
  const pendingPointCards: Card[] = [];
  for (const t of s.tricks) {
    if (team.includes(t.winner)) continue;
    const target = opponentSet.has(t.winner) ? opponentPointCards : pendingPointCards;
    for (const p of t.plays) for (const c of p.cards) if (cardPoints(c) > 0) target.push(c);
  }
  // 只有最后埋底的人能看底：一般是庄家，四人局有人抄底就换成抄底的人（GitHub issue #6）
  const buryer = s.buryer ?? s.dealer;
  const ownerSees = seat === buryer && (s.phase === 'bottom' || s.phase === 'chaodi' || s.phase === 'callFriend' || s.phase === 'playing');
  const showBottom = ownerSees || s.phase === 'roundEnd' || s.phase === 'gameOver';
  return {
    seat,
    config: s.config,
    round: s.round,
    phase: s.phase,
    levels: s.levels,
    dealer: s.dealer,
    // 还没定庄家时各人亮自己的级牌，看到的也是自己的级
    level: declareLevel(s, seat),
    trumpSuit: s.trumpSuit,
    trumpDecided: s.trumpDecided,
    declaration: s.declaration,
    declarationLog: s.declarationLog ?? [],
    hand: sortCards(s.hands[seat] ?? [], { level: declareLevel(s, seat), trumpSuit: s.trumpSuit }),
    handCounts: s.hands.map((h) => h.length),
    bottomCount: s.bottom.length,
    bottom: showBottom ? s.bottom : null,
    buryer,
    chaodi: s.chaodi ?? null,
    deckRemaining: s.deck.length,
    friendCalls: s.friendCalls,
    dealerTeam: team,
    knownOpponents,
    trick: s.trick,
    lastTrick: s.tricks[s.tricks.length - 1] ?? null,
    tricks: s.tricks,
    trickNo: s.tricks.length + 1,
    captured: s.captured,
    visibleOpponentPoints,
    pendingPoints,
    opponentPointCards,
    pendingPointCards,
    penalties: s.penalties,
    currentTurn: currentTurn(s),
    lastRound: s.lastRound,
    winners: s.winners,
  };
}

/**
 * 把分牌汇总成（花色, 点数, 张数），用于顶栏下的「闲家分牌」一行。
 * 副牌按显示顺序（红黑交错），主花色排最后；同花色按 K、10、5 排。只统计 5、10、K。
 */
export function summarizePointCards(cards: readonly Card[], trumpSuit: Suit | null): { suit: Suit; rank: number; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of cards) if (c.suit !== 'J' && cardPoints(c) > 0) counts.set(`${c.suit}${c.rank}`, (counts.get(`${c.suit}${c.rank}`) ?? 0) + 1);
  // suitDisplayOrder 不含主花色，要单独补在最后，否则主花色的分牌会被漏掉
  const suits: Suit[] = trumpSuit ? [...suitDisplayOrder(trumpSuit), trumpSuit] : suitDisplayOrder(null);
  const out: { suit: Suit; rank: number; count: number }[] = [];
  for (const suit of suits) {
    for (const rank of [13, 10, 5]) {
      const count = counts.get(`${suit}${rank}`) ?? 0;
      if (count > 0) out.push({ suit, rank, count });
    }
  }
  return out;
}
