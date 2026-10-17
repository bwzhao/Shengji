import type { Card } from '@shengji/engine';

import { SUIT_GLYPH, SUIT_NAME } from './SuitText.tsx';
const RANK: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function cardLabel(card: Card): string {
  if (card.suit === 'J') return card.rank === 16 ? '大王' : '小王';
  return `${SUIT_NAME[card.suit]} ${RANK[card.rank] ?? card.rank}`;
}

export function CardView({ card, selected, onClick, small, dim, className, style }: {
  card: Card; selected?: boolean; onClick?: () => void; small?: boolean; dim?: boolean; className?: string; style?: React.CSSProperties;
}) {
  const joker = card.suit === 'J';
  const red = card.suit === 'H' || card.suit === 'D' || card.rank === 16;
  const rank = joker ? (card.rank === 16 ? '大王' : '小王') : (RANK[card.rank] ?? String(card.rank));
  const pip = joker ? '★' : SUIT_GLYPH[card.suit];
  const cls = ['card', red ? 'red' : 'black', selected ? 'selected' : '', small ? 'small' : '', dim ? 'dim' : '', joker ? 'joker' : '', className ?? '']
    .filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onClick} disabled={!onClick} style={style} aria-label={cardLabel(card)} aria-pressed={selected}>
      <span className="corner tl"><span className="rank">{rank}</span><span className="suit">{pip}</span></span>
      {!small && <span className="pip">{pip}</span>}
      {!small && <span className="corner br"><span className="rank">{rank}</span><span className="suit">{pip}</span></span>}
    </button>
  );
}

export function CardRow({ cards, small, className }: { cards: readonly Card[]; small?: boolean; className?: string }) {
  return (
    <div className={`card-row ${small ? 'small' : ''} ${className ?? ''}`}>
      {cards.map((c) => <CardView key={c.id} card={c} small={small} />)}
    </div>
  );
}
