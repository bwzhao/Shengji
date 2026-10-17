import { rankName, type CardSuit, type Suit } from '@shengji/engine';

export const SUIT_GLYPH: Record<Suit, string> = { S: '♠\uFE0E', H: '♥\uFE0E', D: '♦\uFE0E', C: '♣\uFE0E' };
export const SUIT_NAME: Record<Suit, string> = { S: '黑桃', H: '红桃', D: '方块', C: '梅花' };
export const suitTone = (suit: Suit) => suit === 'H' || suit === 'D' ? 'suit-red' : 'suit-black';

export function SuitSymbol({ suit, decorative = false }: { suit: Suit; decorative?: boolean }) {
  return <span className={`suit-chip suit-symbol ${suitTone(suit)}`} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : SUIT_NAME[suit]} aria-hidden={decorative || undefined}>{SUIT_GLYPH[suit]}</span>;
}

export function TrumpLabel({ suit, decided = true }: { suit: Suit | null; decided?: boolean }) {
  return !decided ? <b>未定</b> : suit === null ? <b>无主</b> : <SuitSymbol suit={suit} />;
}

export function CardNotation({ suit, rank, count = 1 }: { suit: CardSuit; rank: number; count?: number }) {
  const joker = suit === 'J';
  const label = joker ? (rank === 16 ? '大王' : '小王') : `${SUIT_NAME[suit]} ${rankName(rank)}`;
  const tone = joker ? (rank === 16 ? 'suit-red' : 'suit-black') : suitTone(suit);
  return <span className="card-notation" role="img" aria-label={`${label}${count > 1 ? `，${count} 张` : ''}`}>
    <span className={`suit-chip ${tone}`} aria-hidden="true">{joker ? label : <>{SUIT_GLYPH[suit]}{rankName(rank)}</>}</span>
    {count > 1 && <span className="notation-count" aria-hidden="true">×{count}</span>}
  </span>;
}
