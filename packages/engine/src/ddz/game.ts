/**
 * 三人斗地主的状态机。每人 17 张，留 3 张底牌给地主。
 * 叫分：从先叫的人起每人叫一次，1、2、3 分或不叫，只能比前面叫得高，叫到 3 分直接当地主；都不叫就重发。
 * 地主拿起底牌（亮给所有人看）先出。出完手牌的一方赢。
 * 计分：底分是叫的分，每个炸弹、王炸 ×2，春天（农民一张没出）、反春（地主只出了第一手）×2。
 * 地主赢两个农民各输底分×倍数，地主得两份；地主输反过来。一直打，累计积分。
 */
import { findCards, makeDeck, removeCards, type Card, type CardId } from '../cards.ts';
import { ruleError, type RuleError } from '../errors.ts';
import { createRng } from '../rng.ts';
import type { Seat } from '../state.ts';
import { ddzComboFor, sortDdzHand, type DdzCombo, type DdzComboType } from './combos.ts';

export const DDZ_PLAYERS = 3;
const HAND_SIZE = 17;

export type DdzPhase = 'bidding' | 'playing' | 'roundEnd';

/** 一个人的一次出牌，combo 为 null 是不出 */
export interface DdzPlay {
  readonly seat: Seat;
  readonly combo: DdzCombo | null;
}

export interface DdzRoundResult {
  readonly landlord: Seat;
  readonly bid: number;
  readonly bombs: number;
  readonly spring: 'spring' | 'antiSpring' | null;
  /** 倍数：2 的（炸弹数 + 春天）次方 */
  readonly multiple: number;
  readonly landlordWon: boolean;
  /** 每个人这一局的得失 */
  readonly deltas: readonly number[];
  /** 打完时各人剩下的牌 */
  readonly hands: readonly (readonly Card[])[];
}

export interface DdzState {
  readonly seed: string;
  readonly round: number;
  readonly redeals: number;
  readonly phase: DdzPhase;
  readonly hands: readonly (readonly Card[])[];
  /** 三张底牌；定了地主后公开 */
  readonly bottom: readonly Card[];
  /** 这一局先叫的人 */
  readonly firstBidder: Seat;
  /** 轮到谁：叫分或出牌 */
  readonly turn: Seat;
  /** 这一局每人叫的分：null 还没轮到，0 不叫 */
  readonly bids: readonly (number | null)[];
  readonly landlord: Seat | null;
  /** 底分：最高的叫分 */
  readonly bid: number;
  /** 这一轮要管的牌：最后一手出牌；没有（轮到自由出牌）为 null */
  readonly lastPlay: { readonly seat: Seat; readonly combo: DdzCombo } | null;
  /** 这一轮（从上次自由出牌起）每个人的动作，按先后 */
  readonly roundPlays: readonly DdzPlay[];
  /** 本局每人出过几手牌，算春天用 */
  readonly playCounts: readonly number[];
  /** 本局打出的炸弹和王炸数 */
  readonly bombs: number;
  /** 累计积分 */
  readonly scores: readonly number[];
  readonly lastRound: DdzRoundResult | null;
}

export type DdzAction =
  | { readonly type: 'bid'; readonly seat: Seat; readonly points: number }
  | { readonly type: 'play'; readonly seat: Seat; readonly cards: readonly CardId[] }
  | { readonly type: 'pass'; readonly seat: Seat }
  | { readonly type: 'nextRound' };

export type DdzEvent =
  | { readonly type: 'dealt'; readonly firstBidder: Seat }
  | { readonly type: 'bid'; readonly seat: Seat; readonly points: number }
  | { readonly type: 'redeal' }
  | { readonly type: 'landlord'; readonly seat: Seat; readonly bid: number; readonly bottom: readonly Card[] }
  | { readonly type: 'played'; readonly seat: Seat; readonly combo: DdzComboType; readonly cards: readonly Card[] }
  | { readonly type: 'passed'; readonly seat: Seat }
  | { readonly type: 'roundEnd'; readonly result: DdzRoundResult };

export type DdzResult =
  | { readonly ok: true; readonly state: DdzState; readonly events: DdzEvent[] }
  | { readonly ok: false; readonly error: RuleError };

const next = (seat: Seat): Seat => (seat + 1) % DDZ_PLAYERS;
const ok = (state: DdzState, events: DdzEvent[]): DdzResult => ({ ok: true, state, events });
const fail = (code: RuleError['code'], message: string): DdzResult => ({ ok: false, error: ruleError(code, message) });

/** 洗牌发牌：从先叫的人开始一人一张，最后 3 张做底牌 */
function deal(s: DdzState): DdzState {
  const deck = createRng(`${s.seed}/ddz/${s.round}/${s.redeals}`).shuffle(makeDeck(1));
  const hands: Card[][] = [[], [], []];
  for (let i = 0; i < HAND_SIZE * DDZ_PLAYERS; i++) (hands[(s.firstBidder + i) % DDZ_PLAYERS] as Card[]).push(deck[i] as Card);
  return {
    ...s,
    phase: 'bidding',
    hands,
    bottom: deck.slice(HAND_SIZE * DDZ_PLAYERS),
    turn: s.firstBidder,
    bids: [null, null, null],
    landlord: null,
    bid: 0,
    lastPlay: null,
    roundPlays: [],
    playCounts: [0, 0, 0],
    bombs: 0,
  };
}

/** 新开一场：先叫的人由种子随机定，之后每局轮到下一个人先叫 */
export function createDdzGame(seed: string): DdzState {
  const base: DdzState = {
    seed,
    round: 1,
    redeals: 0,
    phase: 'bidding',
    hands: [[], [], []],
    bottom: [],
    firstBidder: createRng(`${seed}/ddz/first`).int(DDZ_PLAYERS),
    turn: 0,
    bids: [null, null, null],
    landlord: null,
    bid: 0,
    lastPlay: null,
    roundPlays: [],
    playCounts: [0, 0, 0],
    bombs: 0,
    scores: [0, 0, 0],
    lastRound: null,
  };
  return deal(base);
}

export function applyDdzAction(s: DdzState, a: DdzAction): DdzResult {
  switch (a.type) {
    case 'bid': return bid(s, a.seat, a.points);
    case 'play': return play(s, a.seat, a.cards);
    case 'pass': return pass(s, a.seat);
    case 'nextRound': return nextRound(s);
  }
}

function bid(s: DdzState, seat: Seat, points: number): DdzResult {
  if (s.phase !== 'bidding') return fail('WRONG_PHASE', '现在不是叫分阶段');
  if (s.turn !== seat) return fail('NOT_YOUR_TURN', '还没轮到你叫分');
  if (!Number.isInteger(points) || points < 0 || points > 3) return fail('INVALID_ACTION', '只能叫 1、2、3 分或不叫');
  if (points > 0 && points <= s.bid) return fail('INVALID_ACTION', `要比 ${s.bid} 分高`);
  const bids = s.bids.map((b, i) => (i === seat ? points : b));
  const events: DdzEvent[] = [{ type: 'bid', seat, points }];
  const top = points > s.bid ? points : s.bid;
  const bidder = points > s.bid ? seat : bids.findIndex((b) => b === s.bid && b > 0);
  const st: DdzState = { ...s, bids, bid: top };
  // 叫到 3 分，或者三个人都叫过了：最高的当地主；都不叫就重发，换下一个人先叫
  if (points === 3 || bids.every((b) => b !== null)) {
    if (top === 0) {
      events.push({ type: 'redeal' });
      return ok(deal({ ...st, redeals: s.redeals + 1, firstBidder: next(s.firstBidder) }), events);
    }
    const landlord = bidder as Seat;
    const hands = s.hands.map((h, i) => (i === landlord ? [...h, ...s.bottom] : h));
    events.push({ type: 'landlord', seat: landlord, bid: top, bottom: s.bottom });
    return ok({ ...st, phase: 'playing', hands, landlord, turn: landlord, lastPlay: null, roundPlays: [] }, events);
  }
  return ok({ ...st, turn: next(seat) }, events);
}

function play(s: DdzState, seat: Seat, ids: readonly CardId[]): DdzResult {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', '现在不是出牌阶段');
  if (s.turn !== seat) return fail('NOT_YOUR_TURN', '还没轮到你出牌');
  const hand = s.hands[seat] as readonly Card[];
  const cards = findCards(hand, ids);
  if (!cards || cards.length === 0) return fail('CARDS_NOT_IN_HAND', '出的牌不在手中');
  const lead = s.lastPlay && s.lastPlay.seat !== seat ? s.lastPlay.combo : null;
  const combo = ddzComboFor(cards, lead);
  if (!combo) return fail('INVALID_ACTION', lead ? '管不住上家的牌' : '不是能出的牌型');
  const left = removeCards(hand, cards);
  const hands = s.hands.map((h, i) => (i === seat ? left : h));
  const playCounts = s.playCounts.map((c, i) => (i === seat ? c + 1 : c));
  const bombs = s.bombs + (combo.type === 'bomb' || combo.type === 'rocket' ? 1 : 0);
  const events: DdzEvent[] = [{ type: 'played', seat, combo: combo.type, cards }];
  const st: DdzState = {
    ...s,
    hands,
    playCounts,
    bombs,
    lastPlay: { seat, combo },
    roundPlays: [...s.roundPlays, { seat, combo }],
    turn: next(seat),
  };
  if (left.length === 0) {
    const result = settle(st, seat);
    events.push({ type: 'roundEnd', result });
    return ok({ ...st, phase: 'roundEnd', scores: st.scores.map((x, i) => x + (result.deltas[i] as number)), lastRound: result }, events);
  }
  return ok(st, events);
}

function pass(s: DdzState, seat: Seat): DdzResult {
  if (s.phase !== 'playing') return fail('WRONG_PHASE', '现在不是出牌阶段');
  if (s.turn !== seat) return fail('NOT_YOUR_TURN', '还没轮到你出牌');
  if (!s.lastPlay) return fail('INVALID_ACTION', '该你先出，不能不出');
  const to = next(seat);
  const events: DdzEvent[] = [{ type: 'passed', seat }];
  // 两家都不出：轮回到最后出牌的人，由他自由出牌
  if (to === s.lastPlay.seat) return ok({ ...s, turn: to, lastPlay: null, roundPlays: [] }, events);
  return ok({ ...s, turn: to, roundPlays: [...s.roundPlays, { seat, combo: null }] }, events);
}

/** 结算：出完牌的是地主就地主赢 */
function settle(s: DdzState, winner: Seat): DdzRoundResult {
  const landlord = s.landlord as Seat;
  const landlordWon = winner === landlord;
  const peasants = [0, 1, 2].filter((i) => i !== landlord);
  const spring = landlordWon && peasants.every((p) => s.playCounts[p] === 0) ? 'spring'
    : !landlordWon && s.playCounts[landlord] === 1 ? 'antiSpring' : null;
  const multiple = 2 ** (s.bombs + (spring ? 1 : 0));
  const unit = s.bid * multiple;
  const deltas = [0, 1, 2].map((i) => (i === landlord ? 2 : -1) * unit * (landlordWon ? 1 : -1));
  return { landlord, bid: s.bid, bombs: s.bombs, spring, multiple, landlordWon, deltas, hands: s.hands };
}

function nextRound(s: DdzState): DdzResult {
  if (s.phase !== 'roundEnd') return fail('WRONG_PHASE', '这一局还没打完');
  const st = deal({ ...s, round: s.round + 1, redeals: 0, firstBidder: next(s.firstBidder) });
  return ok(st, [{ type: 'dealt', firstBidder: st.firstBidder }]);
}

/** 现在的倍数（还没算春天） */
export function ddzMultiple(s: Pick<DdzState, 'bombs'>): number {
  return 2 ** s.bombs;
}

/** 某个座位能看到的信息 */
export interface DdzView {
  readonly seat: Seat;
  readonly round: number;
  readonly phase: DdzPhase;
  readonly hand: readonly Card[];
  readonly handCounts: readonly number[];
  /** 定了地主后公开的三张底牌；叫分时为 null */
  readonly bottom: readonly Card[] | null;
  readonly firstBidder: Seat;
  readonly turn: Seat;
  readonly bids: readonly (number | null)[];
  readonly landlord: Seat | null;
  readonly bid: number;
  readonly lastPlay: { readonly seat: Seat; readonly combo: DdzCombo } | null;
  readonly roundPlays: readonly DdzPlay[];
  readonly bombs: number;
  readonly multiple: number;
  readonly scores: readonly number[];
  readonly lastRound: DdzRoundResult | null;
}

export function ddzViewFor(s: DdzState, seat: Seat): DdzView {
  return {
    seat,
    round: s.round,
    phase: s.phase,
    hand: sortDdzHand(s.hands[seat] ?? []),
    handCounts: s.hands.map((h) => h.length),
    bottom: s.landlord === null ? null : s.bottom,
    firstBidder: s.firstBidder,
    turn: s.turn,
    bids: s.bids,
    landlord: s.landlord,
    bid: s.bid,
    lastPlay: s.lastPlay,
    roundPlays: s.roundPlays,
    bombs: s.bombs,
    multiple: ddzMultiple(s),
    scores: s.scores,
    lastRound: s.lastRound,
  };
}
