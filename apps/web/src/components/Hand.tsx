import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Card, PlayerView } from '@shengji/engine';
import { layoutHand } from '../handLayout.ts';
import { CardView } from './CardView.tsx';

export function Hand({ cards, ctx, selected, onToggle, dimCard, newIds, declarableIds }: {
  cards: readonly Card[]; ctx: Pick<PlayerView, 'level' | 'trumpSuit'>;
  selected: readonly string[]; onToggle: (id: string) => void;
  dimCard: (c: Card) => boolean; newIds: ReadonlySet<string>; declarableIds: ReadonlySet<string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 320, cardWidth: 48, compact: true });
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => {
      const style = getComputedStyle(el);
      const next = { width: el.clientWidth, cardWidth: parseFloat(style.getPropertyValue('--w')), compact: style.getPropertyValue('--compact').trim() === '1' };
      setSize((prev) => prev.width === next.width && prev.cardWidth === next.cardWidth && prev.compact === next.compact ? prev : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const { rows, step } = layoutHand(cards, ctx, size.width, size.cardWidth, size.compact);
  // Keep every card under one parent: changing row boundaries never remounts a focused card.
  return <div className="hand" ref={ref} role="group" aria-label={`你的手牌，共 ${cards.length} 张，${rows.length} 排`} data-rows={rows.length}
    style={{ '--rows': Math.max(1, rows.length), '--step': `${step}px` } as CSSProperties}>
    {rows.flatMap((row, r) => row.map((c, i) => <CardView key={c.id} card={c} selected={selected.includes(c.id)} dim={dimCard(c)}
      style={{ '--row': r, '--column': i } as CSSProperties}
      className={`${newIds.has(c.id) ? 'dealt' : ''} ${declarableIds.has(c.id) ? 'declarable' : ''}`}
      onClick={() => onToggle(c.id)} />))}
  </div>;
}
