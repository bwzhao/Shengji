/** Deterministic acceptance fixtures reached only through legal engine actions. */
import { createGame, defaultConfig, createRng, applyAction, botDeclare, botAction, cardPoints, currentTurn, type Action, type GameEvent, type GameState } from '../packages/engine/src/index.ts';

export function traceFixture(players: 4 | 5 | 6, cut: number, pointBottom = false, onAction?: (state: GameState, events: readonly GameEvent[]) => void) {
  const seed = `pr9-design-${players}-0${pointBottom ? '-point-bottom' : ''}`;
  const rng = createRng(`bot/${seed}`);
  const opts = { declareProbability: 1, throwProbability: 1 };
  let state = createGame(defaultConfig(players), seed);
  let initial = state, actions: Action[] = [], actionNo = 0;
  const apply = (action: Action) => {
    if (actionNo >= cut) return;
    const result = applyAction(state, action);
    if (!result.ok) throw Error(`${seed} #${actionNo + 1}: ${result.error.message}`);
    state = result.state; actionNo++;
    if (action.type === 'nextRound') { initial = state; actions = []; }
    else actions.push(action);
    onAction?.(state, result.events);
  };
  while (actionNo < cut) {
    if (state.phase === 'dealing') { apply({ type: 'dealCard' }); continue; }
    if (state.phase === 'declaring') {
      for (let seat = 0; seat < players && actionNo < cut; seat++) {
        const action = botDeclare(state, seat, rng, opts);
        if (action) apply(action);
      }
      if (actionNo < cut) apply({ type: 'closeDeclaring' });
      continue;
    }
    if (state.phase === 'roundEnd') { apply({ type: 'nextRound' }); continue; }
    const turn = currentTurn(state);
    if (turn === null) throw Error(`${seed}: no turn at #${actionNo}`);
    let action = botAction(state, turn, rng, opts);
    if (!action) throw Error(`${seed}: no action at #${actionNo}`);
    if (pointBottom && action.type === 'exchangeBottom') action = { ...action, cards: [...state.hands[turn]!].sort((a, b) => cardPoints(b) - cardPoints(a)).slice(0, state.config.bottomSize).map(c => c.id) };
    apply(action);
  }
  return { state, initial, actions, seed, actionNo };
}
