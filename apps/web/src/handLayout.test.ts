import { describe, expect, it } from 'vitest';
import { makeDeck, sortCardsDesc } from '@shengji/engine';
import { layoutHand } from './handLayout.ts';

const ctx = { level: 7, trumpSuit: 'S' as const };
const deck = sortCardsDesc(makeDeck(3), ctx);
describe('responsive hand layout', () => {
  it('preserves every unique card, order, and readable corners for initial and bottom hands', () => {
    for (const width of [244, 280, 328, 358, 460, 598, 1040]) {
      for (let count = 1; count <= 38; count++) {
        const hand = deck.slice(0, count);
        const result = layoutHand(hand, ctx, width, 48, true);
        expect(result.rows.flat()).toEqual(hand);
        expect(new Set(result.rows.flat().map(c => c.id)).size).toBe(count);
        for (const row of result.rows) expect(48 + (row.length - 1) * result.step).toBeLessThanOrEqual(width + .001);
        if (count > 1) expect(result.step).toBeGreaterThanOrEqual(22);
        if (count > 8) expect(result.rows.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
  it('uses the same spacing for unequal left-aligned rows, keeping the short row short', () => {
    const result = layoutHand(deck.slice(0, 15), ctx, 328, 48, true);
    expect(result.rows).toHaveLength(2);
    expect(result.step).toBe(32);
    expect(result.rows.some(r => 48 + (r.length - 1) * result.step < 328)).toBe(true);
  });
  it('uses two rows for 26 cards and more rows for a 38-card bottom hand on a phone', () => {
    expect(layoutHand(deck.slice(0, 26), ctx, 328, 48, true).rows).toHaveLength(2);
    expect(layoutHand(deck.slice(0, 38), ctx, 328, 48, true).rows).toHaveLength(3);
  });
  it('handles empty hands and a zero-width first measurement', () => {
    expect(layoutHand([], ctx, 0, 48, true)).toEqual({ rows: [], step: 0 });
    expect(layoutHand(deck.slice(0, 3), ctx, 0, 48, true).rows).toHaveLength(3);
  });
});
