import { useId, useState } from 'react';
import { SUITS, rankName, type PlayerView, type Suit } from '@shengji/engine';
import type { ClientMessage } from '@shengji/protocol';

import { SUIT_GLYPH, SUIT_NAME, suitTone } from './SuitText.tsx';
const NTH = ['第一张', '第二张', '第三张'];

interface Call { suit: Suit; rank: number; nth: number }

export function FriendCallForm({ view, send, disabled = false }: { view: PlayerView; disabled?: boolean; send: (m: ClientMessage) => void }) {
  const groupId = useId();
  const suits = SUITS.filter((s) => s !== view.trumpSuit);
  const ranks = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2].filter((r) => r !== view.level);
  const [calls, setCalls] = useState<Call[]>(() =>
    Array.from({ length: view.config.friendCount }, (_, i) => ({ suit: suits[0] as Suit, rank: ranks[0] as number, nth: i + 1 })),
  );
  const update = (i: number, patch: Partial<Call>) => setCalls((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const dup = new Set(calls.map((c) => `${c.suit}${c.rank}#${c.nth}`)).size !== calls.length;
  return (
    <div className="friend-form">
      <div className="panel-title">叫朋友</div>
      {calls.map((c, i) => (
        <div key={i} className="friend-row">
          <select disabled={disabled} aria-label={`朋友 ${i + 1} 的出现次序`} value={c.nth} onChange={(e) => update(i, { nth: Number(e.target.value) })}>
            {NTH.slice(0, view.config.decks).map((n, k) => <option key={k} value={k + 1}>{n}</option>)}
          </select>
          <fieldset className="suit-radios" disabled={disabled}>
            <legend className="sr-only">朋友 {i + 1} 的花色</legend>
            {suits.map((s) => <label key={s} className="suit-radio">
              <input type="radio" className="sr-only-input" name={`${groupId}-${i}`} value={s} checked={c.suit === s} onChange={() => update(i, { suit: s })} />
              <span className={`suit-radio-face ${suitTone(s)}`} aria-hidden="true">{SUIT_GLYPH[s]}</span><span className="sr-only">{SUIT_NAME[s]}</span>
            </label>)}
          </fieldset>
          <select disabled={disabled} aria-label={`朋友 ${i + 1} 的点数`} value={c.rank} onChange={(e) => update(i, { rank: Number(e.target.value) })}>
            {ranks.map((r) => <option key={r} value={r}>{rankName(r)}</option>)}
          </select>
        </div>
      ))}
      {dup && <div className="hint warn">两个朋友牌不能完全相同</div>}
      <button className="primary" disabled={disabled || dup} onClick={() => send({ t: 'callFriend', calls })}>确定</button>
    </div>
  );
}
