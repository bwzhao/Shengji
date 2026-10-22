/** 观看者的视图（GitHub issue #8）：跟着某个座位看手牌，底牌也看得到。 */
import { expect, it } from 'vitest';
import { defaultConfig } from '../src/config.ts';
import { applyAction, createGame, waitingSeats } from '../src/reducer.ts';
import { createRng } from '../src/rng.ts';
import { smartAction } from '../src/smartbot.ts';
import { declarationCandidates } from '../src/bot.ts';
import type { GameState } from '../src/state.ts';
import { spectatorView, viewFor } from '../src/view.ts';

function step(s: GameState, a: Parameters<typeof applyAction>[1]): GameState {
  const r = applyAction(s, a);
  if (!r.ok) throw new Error(r.error.message);
  return r.state;
}

it('观看者跟着哪个座位就看他的手牌，底牌一直看得到；玩家自己看不到底', () => {
  const rng = createRng('spectator');
  let s = createGame(defaultConfig(4), 'spectator');
  while (s.phase !== 'playing') {
    if (s.phase === 'dealing') { s = step(s, { type: 'dealCard' }); continue; }
    if (s.phase === 'declaring') {
      const opt = declarationCandidates(s.hands[0] ?? [], s, 0)[0];
      s = step(s, s.declaration === null && opt ? { type: 'declare', seat: 0, cards: opt.map((c) => c.id) } : { type: 'closeDeclaring' });
      continue;
    }
    s = step(s, smartAction(s, waitingSeats(s)[0]!, rng)!);
  }
  const watcher = s.dealer === 1 ? 2 : 1;
  const v = spectatorView(s, watcher);
  expect(v.seat).toBe(watcher);
  expect(v.hand.map((c) => c.id).sort()).toEqual(s.hands[watcher]!.map((c) => c.id).sort());
  expect(v.bottom).toEqual(s.bottom);
  expect(viewFor(s, watcher).bottom).toBeNull();
});
