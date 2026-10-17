import type { PlayerView, Seat } from '@shengji/engine';

export type PenaltySide = 'dealer' | 'opponent' | 'pending';
export interface PenaltyEntry {
  readonly seat: Seat;
  readonly amount: number;
  readonly side: PenaltySide;
  readonly opponentDelta: number | null;
}
export interface PenaltySummary {
  readonly kind: 'live' | 'settled';
  readonly entries: readonly PenaltyEntry[];
  readonly confirmedDelta: number;
  readonly pendingTotal: number;
}
export type PenaltyView = Pick<PlayerView, 'phase' | 'round' | 'penalties' | 'dealerTeam' | 'knownOpponents' | 'lastRound'>;

/** Derive only from public identities; terminal scoring belongs to the matching result. */
export function penaltySummary(view: PenaltyView): PenaltySummary | null {
  const settled = view.phase === 'roundEnd' || view.phase === 'gameOver';
  if (!settled && view.phase !== 'playing') return null;
  if (settled && (!view.lastRound || view.lastRound.round !== view.round)) return null;
  const dealerTeam = settled ? view.lastRound!.dealerTeam : view.dealerTeam;
  const opponents = settled ? view.lastRound!.opponents : view.knownOpponents;
  const entries: PenaltyEntry[] = [];
  let confirmedDelta = 0, pendingTotal = 0;
  view.penalties.forEach((amount, seat) => {
    if (amount <= 0) return;
    const side: PenaltySide = dealerTeam.includes(seat) ? 'dealer' : opponents.includes(seat) ? 'opponent' : 'pending';
    const opponentDelta = side === 'dealer' ? amount : side === 'opponent' ? -amount : null;
    entries.push({ seat, amount, side, opponentDelta });
    if (opponentDelta === null) pendingTotal += amount;
    else confirmedDelta += opponentDelta;
  });
  return { kind: settled ? 'settled' : 'live', entries, confirmedDelta: settled ? view.lastRound!.penaltyDelta : confirmedDelta, pendingTotal: settled ? 0 : pendingTotal };
}
