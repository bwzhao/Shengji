/** 用随机机器人跑完整局，检查不变量，收集统计。 */
import { botAction, botDeclare, defaultBotOptions, type BotOptions } from '../bot.ts';
import { SMART_V2, candidatePlays, smartAction, smartDeclare, type SmartFeatures } from '../smartbot.ts';
import { defaultSearchOptions, searchAction, searchTuning, type SearchOptions } from '../searchbot.ts';
import { sumPoints } from '../cards.ts';
import { decompose } from '../combos.ts';
import type { GameConfig } from '../config.ts';
import { currentTurn, applyAction, createGame } from '../reducer.ts';
import { createRng } from '../rng.ts';
import type { GameEvent, GameState } from '../state.ts';

export interface SimStats {
  rounds: number;
  redeals: number;
  bottomFlips: number;
  dealerHeld: number;
  throwsAttempted: number;
  throwsFailed: number;
  friendSlots: number;
  friendsRevealed: number;
  dealerSelfFriend: number;
  levelsUpHistogram: Record<string, number>;
  opponentPointsSum: number;
  gameOver: boolean;
  winners: readonly number[] | null;
  actions: number;
  /** 结束时各座位的等级下标 */
  finalLevels: readonly number[];
  /** 各座位成为获胜阵营成员的次数 */
  roundWins: number[];
  /** 各座位累计升级数（含到 A 后的溢出） */
  levelGain: number[];
  /** 各座位坐庄次数与守住次数 */
  dealerRounds: number[];
  dealerHolds: number[];
}

export interface SimOptions {
  readonly maxRounds?: number;
  readonly bot?: BotOptions;
  /** 哪些座位用第二版策略机器人 */
  readonly smartSeats?: readonly number[];
  /** 第二版机器人启用的特性，默认全开 */
  readonly smartFeatures?: SmartFeatures;
  /** 哪些座位用第一版策略机器人，其余用随机机器人 */
  readonly basicSeats?: readonly number[];
  /** 哪些座位用第三版搜索机器人 */
  readonly strongSeats?: readonly number[];
  readonly search?: SearchOptions;
  /** 只开一部分二版特性的座位，与 subsetFeatures 配合做特性 A/B */
  readonly subsetSeats?: readonly number[];
  readonly subsetFeatures?: SmartFeatures;
  /** 搜索座位里哪些启用手牌推断网络（不传则全按 searchTuning.belief） */
  readonly beliefSeats?: readonly number[];
  /** 搜索座位里哪些启用价值网络（不传则全按 searchTuning.value） */
  readonly valueSeats?: readonly number[];
  /** 二版机器人出牌时以这个概率改从规则打分前 4 名里随机挑一个，让训练数据更多样 */
  readonly noise?: number;
  readonly onEvent?: (e: GameEvent, s: GameState) => void;
}

function assertInvariants(s: GameState): void {
  const total = s.config.decks * 54;
  let inPlay = s.deck.length + s.bottom.length;
  for (const h of s.hands) inPlay += h.length;
  if (s.trick) for (const p of s.trick.plays) inPlay += p.cards.length;
  for (const t of s.tricks) for (const p of t.plays) inPlay += p.cards.length;
  if (inPlay !== total) throw new Error(`牌数不守恒：${inPlay} ≠ ${total}（round ${s.round}, phase ${s.phase}）`);
  if (s.phase === 'roundEnd' || s.phase === 'gameOver') {
    let captured = 0;
    for (const c of s.captured) captured += c;
    const bottom = sumPoints(s.bottom);
    if (captured + bottom !== s.config.decks * 100) {
      throw new Error(`分数不守恒：抓分 ${captured} + 底牌 ${bottom} ≠ ${s.config.decks * 100}`);
    }
  }
}

function step(s: GameState, action: Parameters<typeof applyAction>[1], stats: SimStats, opts: SimOptions): GameState {
  const r = applyAction(s, action);
  if (!r.ok) throw new Error(`非法操作 ${action.type}: ${r.error.code} ${r.error.message}`);
  stats.actions++;
  for (const e of r.events) {
    opts.onEvent?.(e, r.state);
    switch (e.type) {
      case 'redeal': stats.redeals++; break;
      case 'declaringClosed': if (e.byBottom) stats.bottomFlips++; break;
      case 'throwFailed': stats.throwsFailed++; break;
      case 'friendRevealed': if (e.seat === r.state.dealer) stats.dealerSelfFriend++; else stats.friendsRevealed++; break;
      case 'roundScored': {
        stats.rounds++;
        for (const w of (e.result.dealerHeld ? e.result.dealerTeam : e.result.opponents)) {
          stats.roundWins[w] = (stats.roundWins[w] ?? 0) + 1;
          stats.levelGain[w] = (stats.levelGain[w] ?? 0) + e.result.levelsUp;
        }
        stats.dealerRounds[e.result.dealer] = (stats.dealerRounds[e.result.dealer] ?? 0) + 1;
        if (e.result.dealerHeld) stats.dealerHolds[e.result.dealer] = (stats.dealerHolds[e.result.dealer] ?? 0) + 1;
        stats.friendSlots += r.state.config.friendCount;
        if (e.result.dealerHeld) stats.dealerHeld++;
        const key = `${e.result.dealerHeld ? '庄+' : '闲+'}${e.result.levelsUp}`;
        stats.levelsUpHistogram[key] = (stats.levelsUpHistogram[key] ?? 0) + 1;
        stats.opponentPointsSum += e.result.opponentPoints;
        break;
      }
      default: break;
    }
  }
  return r.state;
}

export function simulateGame(config: GameConfig, seed: string, opts: SimOptions = {}): SimStats {
  const rng = createRng(`bot/${seed}`);
  const bot = opts.bot ?? defaultBotOptions;
  const maxRounds = opts.maxRounds ?? 400;
  const stats: SimStats = {
    rounds: 0, redeals: 0, bottomFlips: 0, dealerHeld: 0, throwsAttempted: 0, throwsFailed: 0,
    friendSlots: 0, friendsRevealed: 0, dealerSelfFriend: 0, levelsUpHistogram: {}, opponentPointsSum: 0,
    gameOver: false, winners: null, actions: 0, finalLevels: [], roundWins: Array.from({ length: config.players }, () => 0),
    levelGain: Array.from({ length: config.players }, () => 0),
    dealerRounds: Array.from({ length: config.players }, () => 0),
    dealerHolds: Array.from({ length: config.players }, () => 0),
  };
  const smart = new Set(opts.smartSeats ?? []);
  const basic = new Set(opts.basicSeats ?? []);
  const strong = new Set(opts.strongSeats ?? []);
  const subset = new Set(opts.subsetSeats ?? []);
  const subsetFeats = opts.subsetFeatures ?? SMART_V2;
  const search = opts.search ?? defaultSearchOptions;
  const feats = opts.smartFeatures ?? SMART_V2;
  const declareFor = (st: GameState, seat: number) =>
    smart.has(seat) || strong.has(seat) ? smartDeclare(st, seat, rng, feats)
      : subset.has(seat) ? smartDeclare(st, seat, rng, subsetFeats)
        : basic.has(seat) ? smartDeclare(st, seat, rng, 1) : botDeclare(st, seat, rng, bot);
  const noise = opts.noise ?? 0;
  const noisy = (st: GameState, seat: number) => {
    const cands = candidatePlays(st, seat, rng, feats).slice(0, 4);
    const pick = cands[Math.floor(rng.next() * cands.length)];
    return pick ? { type: 'play' as const, seat, cards: pick.cards.map((c) => c.id) } : smartAction(st, seat, rng, feats);
  };
  const beliefSeats = opts.beliefSeats ? new Set(opts.beliefSeats) : null;
  const valueSeats = opts.valueSeats ? new Set(opts.valueSeats) : null;
  const strongAction = (st: GameState, seat: number) => {
    const before = { belief: searchTuning.belief, value: searchTuning.value };
    if (beliefSeats) searchTuning.belief = beliefSeats.has(seat) ? 1 : 0;
    if (valueSeats) searchTuning.value = valueSeats.has(seat) ? 1 : 0;
    try { return searchAction(st, seat, rng, search); } finally { searchTuning.belief = before.belief; searchTuning.value = before.value; }
  };
  const actionFor = (st: GameState, seat: number) =>
    strong.has(seat) ? strongAction(st, seat)
      : smart.has(seat) ? (noise > 0 && st.phase === 'playing' && currentTurn(st) === seat && rng.next() < noise ? noisy(st, seat) : smartAction(st, seat, rng, feats))
        : subset.has(seat) ? smartAction(st, seat, rng, subsetFeats)
          : basic.has(seat) ? smartAction(st, seat, rng, 1) : botAction(st, seat, rng, bot);
  let s = createGame(config, seed);
  let guard = 0;
  while (s.phase !== 'gameOver') {
    if (++guard > 5_000_000) throw new Error('模拟未终止');
    if (s.round > maxRounds) break;
    switch (s.phase) {
      case 'dealing': {
        for (let seat = 0; seat < config.players; seat++) {
          const d = declareFor(s, seat);
          if (d) s = step(s, d, stats, opts);
        }
        s = step(s, { type: 'dealCard' }, stats, opts);
        break;
      }
      case 'declaring': {
        for (let seat = 0; seat < config.players; seat++) {
          const d = declareFor(s, seat);
          if (d) s = step(s, d, stats, opts);
        }
        s = step(s, { type: 'closeDeclaring' }, stats, opts);
        break;
      }
      case 'bottom':
      case 'chaodi':
      case 'guohe':
      case 'callFriend':
      case 'playing': {
        let acted = false;
        for (let seat = 0; seat < config.players; seat++) {
          const a = actionFor(s, seat);
          if (a) {
            if (a.type === 'play' && s.trick && s.trick.plays.length === 0 && a.cards.length > 0) {
              // 统计甩牌尝试：首出多于一个牌型
              const hand = s.hands[seat] ?? [];
              const played = hand.filter((c) => a.cards.includes(c.id));
              const d = decompose(played, { level: s.level, trumpSuit: s.trumpSuit });
              if (d && d.components.length > 1) stats.throwsAttempted++;
            }
            s = step(s, a, stats, opts);
            acted = true;
            break;
          }
        }
        if (!acted) throw new Error(`阶段 ${s.phase} 没有人能行动`);
        assertInvariants(s);
        break;
      }
      case 'roundEnd': {
        assertInvariants(s);
        s = step(s, { type: 'nextRound' }, stats, opts);
        break;
      }
    }
  }
  stats.gameOver = s.phase === 'gameOver';
  stats.winners = s.winners;
  stats.finalLevels = s.levels;
  return stats;
}
