/** 造反（GitHub issue #13）。 */
import { describe, expect, it } from 'vitest';
import { cardPoints, sumPoints, type Card } from '../src/cards.ts';
import { defaultConfig, type GameConfig } from '../src/config.ts';
import { applyAction, createGame, zaofanError } from '../src/reducer.ts';
import { declarationCandidates } from '../src/bot.ts';
import { simulateGame } from '../src/sim/run.ts';
import type { GameState, Seat } from '../src/state.ts';
import { viewFor } from '../src/view.ts';

function must(r: ReturnType<typeof applyAction>): GameState {
  if (!r.ok) throw new Error(`${r.error.code} ${r.error.message}`);
  return r.state;
}

/** 首局 0 号位亮主坐庄，拿起底牌进入埋底 */
function toBottom(config: GameConfig, seed: string): GameState {
  for (let k = 0; ; k++) {
    let s = createGame(config, `${seed}-${k}`);
    while (s.phase === 'dealing') s = must(applyAction(s, { type: 'dealCard' }));
    const opt = declarationCandidates(s.hands[0] ?? [], s, 0)[0];
    if (!opt) continue;
    s = must(applyAction(s, { type: 'declare', seat: 0, cards: opt.map((c) => c.id) }));
    s = must(applyAction(s, { type: 'closeDeclaring' }));
    expect(s.phase).toBe('bottom');
    return s;
  }
}

/** 和 donor 换牌（只换非级牌、非王，免得动到亮主的牌），把 seat 手里的分调到不多于 target（down）或不少于 target（up） */
function shiftPoints(s: GameState, seat: Seat, donor: Seat, target: number, dir: 'down' | 'up'): GameState {
  const hands = s.hands.map((h) => [...h]);
  const plain = (c: Card) => c.suit !== 'J' && c.rank !== s.level;
  const done = () => (dir === 'down' ? sumPoints(hands[seat]!) <= target : sumPoints(hands[seat]!) >= target);
  while (!done()) {
    const i = hands[seat]!.findIndex((c) => plain(c) && (dir === 'down' ? cardPoints(c) > 0 : cardPoints(c) === 0));
    const j = hands[donor]!.findIndex((c) => plain(c) && (dir === 'down' ? cardPoints(c) === 0 : cardPoints(c) > 0));
    if (i < 0 || j < 0) throw new Error('凑不出分数');
    [hands[seat]![i], hands[donor]![j]] = [hands[donor]![j]!, hands[seat]![i]!];
  }
  return { ...s, hands };
}

const C4 = defaultConfig(4);

describe('造反（#13）', () => {
  it('庄家埋底时，手里不多于 15 分的人可以造反：从他开始重新发牌抢庄', () => {
    let s = shiftPoints(toBottom(C4, 'zf-low'), 2, 1, 15, 'down');
    expect(sumPoints(s.hands[2]!)).toBeLessThanOrEqual(15);
    const r = applyAction(s, { type: 'zaofan', seat: 2 });
    expect(r.ok && r.events).toEqual([{ type: 'zaofan', seat: 2, points: sumPoints(s.hands[2]!) }]);
    s = must(r);
    expect(s.phase).toBe('dealing');
    expect(s.dealer).toBeNull();
    expect(s.grabFixed).toBe(true);
    expect(s.dealTurn).toBe(2);
    expect(s.hands.every((h) => h.length === 0)).toBe(true);
  });

  it('不少于 85 分也能造反；中间的分数不能', () => {
    const base = toBottom(C4, 'zf-high');
    const high = shiftPoints(base, 3, 1, 85, 'up');
    expect(applyAction(high, { type: 'zaofan', seat: 3 }).ok).toBe(true);
    const mid = shiftPoints(shiftPoints(base, 3, 1, 40, 'up'), 3, 1, 60, 'down');
    const pts = sumPoints(mid.hands[3]!);
    if (pts > 15 && pts < 85) {
      const r = applyAction(mid, { type: 'zaofan', seat: 3 });
      expect(!r.ok && r.error.code).toBe('INVALID_ZAOFAN');
    }
  });

  it('庄家拿着底牌时上限是 95：90 分的庄家不能造反，90 分的闲家可以', () => {
    let s = toBottom(C4, 'zf-dealer');
    s = shiftPoints(shiftPoints(s, 0, 1, 90, 'up'), 0, 1, 94, 'down');
    const dp = sumPoints(s.hands[0]!);
    expect(dp).toBeGreaterThanOrEqual(85);
    expect(dp).toBeLessThan(95);
    expect(zaofanError(s, 0, s.hands[0]!)?.code).toBe('INVALID_ZAOFAN');
    expect(zaofanError(s, 2, s.hands[0]!)).toBeNull();
    s = shiftPoints(s, 0, 1, 95, 'up');
    expect(applyAction(s, { type: 'zaofan', seat: 0 }).ok).toBe(true);
  });

  it('四人抄底开始后不能造反', () => {
    let s = shiftPoints(toBottom(C4, 'zf-chaodi'), 2, 1, 15, 'down');
    s = must(applyAction(s, { type: 'exchangeBottom', seat: 0, cards: s.hands[0]!.slice(0, 8).map((c) => c.id) }));
    expect(['chaodi', 'guohe', 'playing']).toContain(s.phase);
    const r = applyAction(s, { type: 'zaofan', seat: 2 });
    expect(!r.ok && r.error.code).toBe('WRONG_PHASE');
  });

  it('五人局叫朋友时闲家还能造反，庄家不能；叫完朋友就不能了', () => {
    const C5 = defaultConfig(5);
    let s = toBottom(C5, 'zf-five');
    s = must(applyAction(s, { type: 'exchangeBottom', seat: 0, cards: s.hands[0]!.slice(0, C5.bottomSize).map((c) => c.id) }));
    expect(s.phase).toBe('callFriend');
    s = shiftPoints(shiftPoints(s, 3, 1, 15, 'down'), 0, 1, 15, 'down');
    expect(zaofanError(s, 0, s.hands[0]!)?.code).toBe('WRONG_PHASE');
    expect(zaofanError(s, 3, s.hands[3]!)).toBeNull();
    const card = s.hands[1]!.find((c) => c.suit !== 'J' && c.rank !== s.level)!;
    const called = must(applyAction(s, { type: 'callFriend', seat: 0, calls: [{ suit: card.suit as 'S', rank: card.rank, nth: 1 }] }));
    expect(called.phase).toBe('playing');
    expect(zaofanError(called, 3, called.hands[3]!)?.code).toBe('WRONG_PHASE');
  });

  it('造反后的首局：谁先亮谁坐庄，别人反主只改主花色', () => {
    let s = must(applyAction(shiftPoints(toBottom(C4, 'zf-grab'), 2, 1, 15, 'down'), { type: 'zaofan', seat: 2 }));
    expect(viewFor(s, 1).grabFixed).toBe(true);
    let first: Seat | null = null;
    while (s.phase === 'dealing') {
      s = must(applyAction(s, { type: 'dealCard' }));
      if (first === null) {
        for (let seat = 0; seat < 4 && first === null; seat++) {
          const single = declarationCandidates(s.hands[seat] ?? [], s, seat).find((o) => o.length === 1);
          if (single) { s = must(applyAction(s, { type: 'declare', seat, cards: single.map((c) => c.id) })); first = seat; }
        }
      }
    }
    expect(first).not.toBeNull();
    expect(s.dealer).toBe(first);
    for (let seat = 0; seat < 4; seat++) {
      if (seat === first) continue;
      const pair = declarationCandidates(s.hands[seat] ?? [], s, seat).find((o) => o.length === 2);
      if (!pair) continue;
      s = must(applyAction(s, { type: 'declare', seat, cards: pair.map((c) => c.id) }));
      expect(s.declaration?.seat).toBe(seat);
      expect(s.dealer).toBe(first);
      return;
    }
  });

  it('自对弈：随机机器人会造反，牌局都能打完', () => {
    let zaofans = 0;
    for (let g = 0; g < 4; g++) {
      for (const players of [4, 5, 6] as const) {
        simulateGame(defaultConfig(players), `zf-sim-${players}-${g}`, {
          maxRounds: 6,
          onEvent: (e) => { if (e.type === 'zaofan') zaofans++; },
        });
      }
    }
    expect(zaofans).toBeGreaterThan(0);
  }, 180_000);
});
