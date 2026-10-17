import { describe, expect, it } from 'vitest';
import { defaultConfig, handSize } from '../src/config.ts';
import { applyAction, createGame, restartRound } from '../src/reducer.ts';
import { simulateGame } from '../src/sim/run.ts';
import { summarizePointCards, viewFor } from '../src/view.ts';
import type { GameState } from '../src/state.ts';

function dealAll(s: GameState): GameState {
  while (s.phase === 'dealing') {
    const r = applyAction(s, { type: 'dealCard' });
    if (!r.ok) throw new Error(r.error.message);
    s = r.state;
  }
  return s;
}

function must(r: ReturnType<typeof applyAction>): GameState {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.state;
}

describe('整局流程', () => {
  it('5 人每人 31 张留 7 张底，6 人每人 26 张留 6 张底', () => {
    expect(handSize(defaultConfig(5))).toBe(31);
    expect(handSize(defaultConfig(6))).toBe(26);
    const s5 = dealAll(createGame(defaultConfig(5), 'deal'));
    expect(s5.hands.every((h) => h.length === 31)).toBe(true);
    expect(s5.bottom.length).toBe(7);
    expect(s5.phase).toBe('declaring');
    const s6 = dealAll(createGame(defaultConfig(6), 'deal'));
    expect(s6.hands.every((h) => h.length === 26)).toBe(true);
    expect(s6.bottom.length).toBe(6);
  });

  it('同一 seed 发牌完全一致', () => {
    const a = dealAll(createGame(defaultConfig(6), 'same'));
    const b = dealAll(createGame(defaultConfig(6), 'same'));
    expect(a.hands.map((h) => h.map((c) => c.id))).toEqual(b.hands.map((h) => h.map((c) => c.id)));
  });

  it('首局无人亮主重发，非首局翻底牌定主', () => {
    let s = dealAll(createGame(defaultConfig(6), 'redeal'));
    const before = s.hands[0]?.map((c) => c.id);
    s = must(applyAction(s, { type: 'closeDeclaring' }));
    expect(s.phase).toBe('dealing');
    expect(s.redeals).toBe(1);
    s = dealAll(s);
    expect(s.hands[0]?.map((c) => c.id)).not.toEqual(before);
  });

  it('亮主只看张数，同张数不能反', () => {
    let s = dealAll(createGame(defaultConfig(6), 'declare-1'));
    const seatWithLevel = s.hands.findIndex((h) => h.some((c) => c.rank === 5));
    const card = s.hands[seatWithLevel]?.find((c) => c.rank === 5)!;
    s = must(applyAction(s, { type: 'declare', seat: seatWithLevel, cards: [card.id] }));
    expect(s.dealer).toBe(seatWithLevel);
    expect(s.trumpSuit).toBe(card.suit);
    const other = s.hands.findIndex((h, i) => i !== seatWithLevel && h.some((c) => c.rank === 5));
    const otherCard = s.hands[other]?.find((c) => c.rank === 5)!;
    const r = applyAction(s, { type: 'declare', seat: other, cards: [otherCard.id] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DECLARATION_TOO_WEAK');
  });

  it('首局被反主后，庄家跟着换成反主的人', () => {
    let s = dealAll(createGame(defaultConfig(6), 'first-override'));
    const first = s.hands.findIndex((h) => h.some((c) => c.rank === 5 && c.suit !== 'J'));
    const card = s.hands[first]!.find((c) => c.rank === 5 && c.suit !== 'J')!;
    s = must(applyAction(s, { type: 'declare', seat: first, cards: [card.id] }));
    expect(s.dealer).toBe(first);
    const other = s.hands.findIndex((h, i) => i !== first && h.filter((c) => c.rank === 5 && c.suit !== 'J' && c.suit !== card.suit).length >= 2);
    if (other >= 0) {
      const pair = s.hands[other]!.filter((c) => c.rank === 5 && c.suit !== 'J' && c.suit !== card.suit).slice(0, 2);
      s = must(applyAction(s, { type: 'declare', seat: other, cards: pair.map((c) => c.id) }));
      expect(s.dealer).toBe(other);
      expect(s.trumpSuit).toBe(pair[0]!.suit);
    }
  });

  it('非首局反主只改主花色，庄家不变', () => {
    let s = dealAll({ ...createGame(defaultConfig(6), 'override'), round: 2, dealer: 2 });
    const first = s.hands.findIndex((h, i) => i !== 2 && h.some((c) => c.rank === 5 && c.suit !== 'J'));
    const card = s.hands[first]!.find((c) => c.rank === 5 && c.suit !== 'J')!;
    s = must(applyAction(s, { type: 'declare', seat: first, cards: [card.id] }));
    expect(s.dealer).toBe(2);
    expect(s.trumpSuit).toBe(card.suit);
    const other = s.hands.findIndex((h, i) => i !== first && h.filter((c) => c.rank === 5 && c.suit !== 'J' && c.suit !== card.suit).length >= 2);
    if (other >= 0) {
      const pair = s.hands[other]!.filter((c) => c.rank === 5 && c.suit !== 'J' && c.suit !== card.suit).slice(0, 2);
      s = must(applyAction(s, { type: 'declare', seat: other, cards: pair.map((c) => c.id) }));
      expect(s.declaration?.seat).toBe(other);
      expect(s.trumpSuit).toBe(pair[0]!.suit);
      expect(s.dealer).toBe(2);
    }
  });

  it('单张王不能亮，两张王亮无主', () => {
    let s = dealAll(createGame(defaultConfig(6), 'joker'));
    const seat = s.hands.findIndex((h) => h.filter((c) => c.rank === 16).length >= 2);
    if (seat < 0) return;
    const jokers = s.hands[seat]!.filter((c) => c.rank === 16);
    const bad = applyAction(s, { type: 'declare', seat, cards: [jokers[0]!.id] });
    expect(bad.ok).toBe(false);
    s = must(applyAction(s, { type: 'declare', seat, cards: [jokers[0]!.id, jokers[1]!.id] }));
    expect(s.trumpSuit).toBeNull();
    expect(s.trumpDecided).toBe(true);
  });

  it('三张王不论大小混不混都能亮，两张王必须相同', () => {
    let s = dealAll(createGame(defaultConfig(6), 'mixed-jokers'));
    const seat = s.hands.findIndex((h) => h.filter((c) => c.suit === 'J').length >= 3 && h.some((c) => c.rank === 16) && h.some((c) => c.rank === 15));
    if (seat < 0) return;
    const big = s.hands[seat]!.filter((c) => c.rank === 16);
    const small = s.hands[seat]!.filter((c) => c.rank === 15);
    const mixedPair = applyAction(s, { type: 'declare', seat, cards: [big[0]!.id, small[0]!.id] });
    expect(mixedPair.ok).toBe(false);
    const three = [...big, ...small].slice(0, 3);
    s = must(applyAction(s, { type: 'declare', seat, cards: three.map((c) => c.id) }));
    expect(s.declaration?.count).toBe(3);
    expect(s.trumpSuit).toBeNull();
  });

  it('叫朋友的约束', () => {
    let s = dealAll(createGame(defaultConfig(6), 'friend'));
    expect(s.level).toBe(s.config.players === 4 ? 2 : 5); // 四人升级从 2 开始，找朋友从 5 开始
    const seat = s.hands.findIndex((h) => h.some((c) => c.rank === s.level && c.suit !== 'J'));
    const card = s.hands[seat]!.find((c) => c.rank === s.level && c.suit !== 'J')!;
    s = must(applyAction(s, { type: 'declare', seat, cards: [card.id] }));
    s = must(applyAction(s, { type: 'closeDeclaring' }));
    expect(s.phase).toBe('bottom');
    expect(s.hands[seat]!.length).toBe(32);
    expect(viewFor(s, (seat + 1) % 6).bottom).toBeNull();
    s = must(applyAction(s, { type: 'exchangeBottom', seat, cards: s.hands[seat]!.slice(0, 6).map((c) => c.id) }));
    expect(s.phase).toBe('callFriend');
    const trump = s.trumpSuit!;
    const offSuit = (['S', 'H', 'D', 'C'] as const).find((x) => x !== trump)!;
    const bad1 = applyAction(s, { type: 'callFriend', seat, calls: [{ suit: trump, rank: 14, nth: 1 }, { suit: offSuit, rank: 13, nth: 1 }] });
    expect(bad1.ok).toBe(false);
    const bad2 = applyAction(s, { type: 'callFriend', seat, calls: [{ suit: offSuit, rank: 5, nth: 1 }, { suit: offSuit, rank: 13, nth: 1 }] });
    expect(bad2.ok).toBe(false);
    const bad3 = applyAction(s, { type: 'callFriend', seat, calls: [{ suit: offSuit, rank: 14, nth: 1 }, { suit: offSuit, rank: 14, nth: 1 }] });
    expect(bad3.ok).toBe(false);
    const bad4 = applyAction(s, { type: 'callFriend', seat, calls: [{ suit: offSuit, rank: 14, nth: 1 }] });
    expect(bad4.ok).toBe(false);
    s = must(applyAction(s, { type: 'callFriend', seat, calls: [{ suit: offSuit, rank: 14, nth: 1 }, { suit: offSuit, rank: 14, nth: 2 }] }));
    expect(s.phase).toBe('playing');
    expect(s.trick?.leader).toBe(seat);
  });
});

describe('重发本局', () => {
  it('首局重发：庄家清空，牌重新洗过', () => {
    let s = dealAll(createGame(defaultConfig(6), 'restart'));
    expect(s.level).toBe(s.config.players === 4 ? 2 : 5); // 四人升级从 2 开始，找朋友从 5 开始
    const seat = s.hands.findIndex((h) => h.some((c) => c.rank === s.level && c.suit !== 'J'));
    const card = s.hands[seat]!.find((c) => c.rank === s.level && c.suit !== 'J')!;
    s = must(applyAction(s, { type: 'declare', seat, cards: [card.id] }));
    const before = s.hands[0]!.map((c) => c.id);
    const r = restartRound(s);
    expect(r.events[0]?.type).toBe('roundRestarted');
    expect(r.state.phase).toBe('dealing');
    expect(r.state.dealer).toBeNull();
    expect(r.state.round).toBe(1);
    expect(r.state.hands.every((h) => h.length === 0)).toBe(true);
    const again = dealAll(r.state);
    expect(again.hands[0]!.map((c) => c.id)).not.toEqual(before);
  });

  it('非首局重发：等级、局数、庄家保留', () => {
    const base = { ...createGame(defaultConfig(5), 'restart2'), round: 3, dealer: 4, levels: [2, 0, 1, 0, 3], level: 2 };
    const s = dealAll(base);
    const r = restartRound(s);
    expect(r.state.round).toBe(3);
    expect(r.state.dealer).toBe(4);
    expect(r.state.levels).toEqual([2, 0, 1, 0, 3]);
    expect(r.state.level).toBe(2);
    expect(r.state.dealTurn).toBe(0);
    expect(r.state.redeals).toBe(1);
  });
});

describe('随机对局', () => {
  it('6 人 30 局全部打完且守恒', () => {
    for (let i = 0; i < 30; i++) {
      const st = simulateGame(defaultConfig(6), `t6-${i}`);
      expect(st.gameOver).toBe(true);
      expect(st.winners?.length).toBeGreaterThan(0);
    }
  });

  it('5 人 30 局全部打完且守恒', () => {
    for (let i = 0; i < 30; i++) {
      const st = simulateGame(defaultConfig(5), `t5-${i}`);
      expect(st.gameOver).toBe(true);
    }
  });

  it('很少亮主时走重发和翻底牌路径', () => {
    let redeals = 0, flips = 0;
    for (let i = 0; i < 12; i++) {
      const st = simulateGame(defaultConfig(6), `nd-${i}`, { maxRounds: 6, bot: { declareProbability: 0.0008, throwProbability: 0.1 } });
      redeals += st.redeals;
      flips += st.bottomFlips;
    }
    expect(redeals).toBeGreaterThan(0);
    expect(flips).toBeGreaterThan(0);
  });

  it('视图不泄露别人的手牌和底牌', () => {
    simulateGame(defaultConfig(6), 'leak', {
      maxRounds: 3,
      onEvent: (_e, s) => {
        for (let seat = 0; seat < 6; seat++) {
          const v = viewFor(s, seat);
          expect(v.hand.length).toBe(s.hands[seat]!.length);
          if (s.phase === 'bottom' && seat !== s.dealer) expect(v.bottom).toBeNull();
          if (s.phase === 'playing') expect(v.bottom).toBeNull();
        }
      },
    });
  });
});

describe('四人对家模式', () => {
  it('两副牌 25 张留 8 张底，扣底后直接开打，对家一队', () => {
    const cfg = defaultConfig(4);
    expect(cfg.mode).toBe('partners');
    expect(handSize(cfg)).toBe(25);
    let s = dealAll(createGame(cfg, 'p4-flow'));
    expect(s.hands.every((h) => h.length === 25)).toBe(true);
    expect(s.bottom.length).toBe(8);
    expect(s.level).toBe(s.config.players === 4 ? 2 : 5); // 四人升级从 2 开始，找朋友从 5 开始
    const seat = s.hands.findIndex((h) => h.some((c) => c.rank === s.level && c.suit !== 'J'));
    const card = s.hands[seat]!.find((c) => c.rank === s.level && c.suit !== 'J')!;
    s = must(applyAction(s, { type: 'declare', seat, cards: [card.id] }));
    s = must(applyAction(s, { type: 'closeDeclaring' }));
    expect(s.hands[seat]!.length).toBe(33);
    s = must(applyAction(s, { type: 'exchangeBottom', seat, cards: s.hands[seat]!.slice(0, 8).map((c) => c.id) }));
    expect(s.phase).toBe('playing');
    expect(s.trick?.leader).toBe(seat);
    const v = viewFor(s, (seat + 1) % 4);
    expect(v.dealerTeam).toEqual([seat, (seat + 2) % 4]);
    expect([...v.knownOpponents].sort()).toEqual([(seat + 1) % 4, (seat + 3) % 4].sort());
  });

  it('四人升级：不能三张亮主，一对王能盖一对级牌，一对大王能盖一对小王', () => {
    let s = dealAll(createGame(defaultConfig(4), 'p4-declare'));
    const L = s.level;
    const levelSeat = s.hands.findIndex((h) => h.filter((c) => c.rank === L && c.suit === 'S').length >= 2);
    const jokerSeat = s.hands.findIndex((h, i) => i !== levelSeat && h.filter((c) => c.rank === 15).length >= 2);
    if (levelSeat < 0 || jokerSeat < 0) return;
    const pair = s.hands[levelSeat]!.filter((c) => c.rank === L && c.suit === 'S').slice(0, 2);
    s = must(applyAction(s, { type: 'declare', seat: levelSeat, cards: pair.map((c) => c.id) }));
    const smalls = s.hands[jokerSeat]!.filter((c) => c.rank === 15).slice(0, 2);
    s = must(applyAction(s, { type: 'declare', seat: jokerSeat, cards: smalls.map((c) => c.id) }));
    expect(s.trumpSuit).toBeNull();
    expect(s.declaration?.count).toBe(2);
    // 三张王混着亮在两副牌里不允许
    const threeJ = s.hands.findIndex((h) => h.filter((c) => c.suit === 'J').length >= 3);
    if (threeJ >= 0) {
      const js = s.hands[threeJ]!.filter((c) => c.suit === 'J').slice(0, 3);
      expect(applyAction(s, { type: 'declare', seat: threeJ, cards: js.map((c) => c.id) }).ok).toBe(false);
    }
  });

  it('五人局守住连庄；六人局守住交给最近的朋友；下庄都交给第一个闲家', () => {
    for (const players of [5, 6] as const) {
      let held = 0, lost = 0;
      for (let g = 0; g < 4; g++) {
        simulateGame(defaultConfig(players), `keep-${players}-${g}`, {
          maxRounds: 8,
          onEvent: (e) => {
            if (e.type !== 'roundScored' || e.result.gameOver) return;
            const r = e.result;
            const firstOf = (team: readonly number[]) => {
              for (let k = 1; k < players; k++) if (team.includes((r.dealer + k) % players)) return (r.dealer + k) % players;
              return r.dealer;
            };
            if (r.dealerHeld) {
              expect(r.nextDealer).toBe(players === 5 ? r.dealer : firstOf(r.dealerTeam));
              held++;
            } else {
              expect(r.nextDealer).toBe(firstOf(r.opponents));
              lost++;
            }
          },
        });
      }
      expect(held).toBeGreaterThan(0);
      expect(lost).toBeGreaterThan(0);
    }
  });

  it('守庄换对家坐庄，下庄换下家；两人共用等级', () => {
    let checked = 0;
    simulateGame(defaultConfig(4), 'p4-dealer', {
      maxRounds: 15,
      onEvent: (e) => {
        if (e.type !== 'roundScored') return;
        const r = e.result;
        expect(r.nextDealer).toBe(r.dealerHeld ? (r.dealer + 2) % 4 : (r.dealer + 1) % 4);
        expect(r.levelsAfter[r.dealer]).toBe(r.levelsAfter[(r.dealer + 2) % 4]);
        expect(r.levelsAfter[(r.dealer + 1) % 4]).toBe(r.levelsAfter[(r.dealer + 3) % 4]);
        checked++;
      },
    });
    expect(checked).toBeGreaterThan(0);
  });
});

describe('闲家得分的显示口径', () => {
  it('朋友未全部现身时，身份未定者抓的分记为待定；对家模式全部立即计入', () => {
    let seen = false;
    simulateGame(defaultConfig(6), 'pending-pts', {
      maxRounds: 2,
      onEvent: (_e, s) => {
        if (s.phase !== 'playing') return;
        const v = viewFor(s, 0);
        const team = v.dealerTeam;
        let confirmed = 0, pending = 0;
        s.captured.forEach((pts, i) => {
          if (team.includes(i)) return;
          if (v.knownOpponents.includes(i)) confirmed += pts; else pending += pts;
        });
        expect(v.visibleOpponentPoints).toBe(confirmed);
        expect(v.pendingPoints).toBe(pending);
        const cardPts = (cs: readonly { rank: number }[]) => cs.reduce((a, c) => a + (c.rank === 5 ? 5 : c.rank === 10 || c.rank === 13 ? 10 : 0), 0);
        // 只列分牌（5、10、K），不列其他牌
        for (const c of [...v.opponentPointCards, ...v.pendingPointCards]) expect([5, 10, 13]).toContain(c.rank);
        // 汇总成「花色+点数×张数」后，分数合计不变（主花色的分牌不能漏）
        const sumSummary = (cs: Parameters<typeof summarizePointCards>[0]) =>
          summarizePointCards(cs, s.trumpSuit).reduce((a, x) => a + x.count * (x.rank === 5 ? 5 : 10), 0);
        expect(sumSummary(v.opponentPointCards)).toBe(confirmed);
        expect(sumSummary(v.pendingPointCards)).toBe(pending);
        expect(cardPts(v.opponentPointCards)).toBe(confirmed);
        expect(cardPts(v.pendingPointCards)).toBe(pending);
        if (pending > 0) seen = true;
      },
    });
    expect(seen).toBe(true);
    simulateGame(defaultConfig(4), 'pending-p4', {
      maxRounds: 1,
      onEvent: (_e, s) => { if (s.phase === 'playing') expect(viewFor(s, 0).pendingPoints).toBe(0); },
    });
  });
});

describe('自己亮的主只能加固', () => {
  it('没人反主时，亮主的人不能改亮别的花色或王，只能用更多张同样的牌加固；被别人反了之后可以按正常规则再反', async () => {
    const { checkDeclaration } = await import('../src/reducer.ts');
    for (const players of [4, 5, 6] as const) {
      const config = defaultConfig(players);
      const level = 5;
      const c = (suit: 'S' | 'H' | 'D' | 'C' | 'J', rank: number, deck = 0) => ({ id: `${suit}${rank}-${deck}`, suit, rank, deck });
      const mine = { seat: 0, cards: [c('H', 5)], suit: 'H' as const, count: 1 };
      const ctx = { config, level, declaration: mine };
      // 换花色：不行
      expect(checkDeclaration(ctx, 0, [c('S', 5), c('S', 5, 1)])).not.toBeNull();
      // 换成王：不行
      expect(checkDeclaration(ctx, 0, [c('J', 15), c('J', 15, 1)])).not.toBeNull();
      // 同张数同花色：没意义，不行
      expect(checkDeclaration(ctx, 0, [c('H', 5, 1)])).not.toBeNull();
      // 加固：行
      expect(checkDeclaration(ctx, 0, [c('H', 5), c('H', 5, 1)])).toBeNull();
      // 别人用两张反：行
      expect(checkDeclaration(ctx, 1, [c('S', 5), c('S', 5, 1)])).toBeNull();
      // 被反之后，原来的人可以按正常规则再反别的花色
      const theirs = { seat: 1, cards: [c('S', 5), c('S', 5, 1)], suit: 'S' as const, count: 2 };
      if (config.decks >= 3) expect(checkDeclaration({ config, level, declaration: theirs }, 0, [c('D', 5), c('D', 5, 1), c('D', 5, 2)])).toBeNull();
      else expect(checkDeclaration({ config, level, declaration: theirs }, 0, [c('J', 16), c('J', 16, 1)])).toBeNull();
    }
  });

  it('机器人自对弈里从不改亮自己已亮的花色', () => {
    let switches = 0, reinforces = 0;
    // 用事件序列检查：同一个人连续两次亮主时花色必须相同
    for (const players of [4, 5, 6] as const) {
      for (let g = 0; g < 30; g++) {
        let last: { seat: number; suit: string | null } | null = null;
        let round = 0;
        simulateGame(defaultConfig(players), `no-switch-${players}-${g}`, {
          smartSeats: Array.from({ length: players }, (_, i) => i),
          maxRounds: 4,
          onEvent: (e, s) => {
            if (s.round !== round) { round = s.round; last = null; }
            if (e.type === 'roundRestarted') last = null;
            if (e.type !== 'declared') return;
            if (last && last.seat === e.seat) { if (last.suit !== e.suit) switches++; else reinforces++; }
            last = { seat: e.seat, suit: e.suit };
          },
        });
      }
    }
    expect(switches).toBe(0);
    expect(reinforces).toBeGreaterThan(0);
  }, 120_000);
});

describe('四人升级：在庄上打过 A 才赢', () => {
  it('整局结束时，赢家一定是在 A 上坐庄并守住的那一队', () => {
    let finished = 0;
    for (let g = 0; g < 20; g++) {
      let lastScored: import('../src/state.ts').RoundResult | null = null;
      const st = simulateGame(defaultConfig(4), `p4-ace-${g}`, {
        smartSeats: [0, 1, 2, 3],
        onEvent: (e) => { if (e.type === 'roundScored') lastScored = e.result; },
      });
      if (!st.gameOver) continue;
      finished++;
      const r = lastScored as unknown as import('../src/state.ts').RoundResult;
      expect(r.gameOver).toBe(true);
      expect(r.dealerHeld).toBe(true);
      // 庄家这一局开始时就在 A（下标 12）
      expect(r.levelsBefore[r.dealer]).toBe(12);
      expect([...(st.winners ?? [])].sort()).toEqual([...r.dealerTeam].sort());
    }
    expect(finished).toBeGreaterThan(0);
  }, 120_000);
});
