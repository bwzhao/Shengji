import { groupOf, identityKey, type Card, type PlayerView } from '@shengji/engine';

type Context = Pick<PlayerView, 'level' | 'trumpSuit'>;
export interface HandLayout { rows: Card[][]; step: number }

/** Keep order and every card visible; prefer suit boundaries, then intact pairs/triples. */
export function layoutHand(hand: readonly Card[], ctx: Context, width: number, cardWidth: number, compact: boolean): HandLayout {
  const minStep = compact ? 22 : 26;
  const preferredStep = compact ? 32 : 42;
  const fit = Math.max(1, Math.floor((Math.max(width, cardWidth) - cardWidth) / minStep) + 1);
  const capacity = compact && hand.length > 8 ? Math.min(fit, hand.length - 1) : fit;
  const rows: Card[][] = [];
  let rest = [...hand];
  while (rest.length > capacity) {
    const count = Math.ceil(rest.length / capacity);
    const target = Math.ceil(rest.length / count);
    const lower = Math.max(1, rest.length - capacity * (count - 1), target - 2);
    const upper = Math.min(capacity, target + 2);
    let cut = target, best = Infinity;
    for (let i = lower; i <= upper; i++) {
      const a = rest[i - 1]!, b = rest[i]!;
      const penalty = groupOf(a, ctx) !== groupOf(b, ctx) ? 0 : identityKey(a) !== identityKey(b) ? 10 : 20;
      const score = penalty + Math.abs(i - target);
      if (score < best) { best = score; cut = i; }
    }
    rows.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) rows.push(rest);
  const longest = Math.max(1, ...rows.map((r) => r.length));
  return { rows, step: Math.max(0, Math.min(preferredStep, (width - cardWidth) / Math.max(1, longest - 1))) };
}
