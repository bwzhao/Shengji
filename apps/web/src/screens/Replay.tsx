/** 一局回放：按墩列出每个人出的牌、赢家和分数，并可展开各人起手牌。 */
import { useMemo, useState } from 'react';
import { applyAction, rankName, sortCardsDesc, type Card, type GameState, type Seat } from '@shengji/engine';
import type { RoundReplay } from '@shengji/protocol';
import { Modal } from '../components/Modal.tsx';
import { CardRow } from '../components/CardView.tsx';
import { CardNotation, TrumpLabel } from '../components/SuitText.tsx';

interface TrickView {
  readonly no: number;
  readonly leader: Seat;
  readonly winner: Seat;
  readonly points: number;
  readonly plays: readonly { seat: Seat; cards: readonly Card[] }[];
  readonly revealed: readonly Seat[];
  readonly throwFailed: readonly Seat[];
}

interface Rebuilt {
  readonly final: GameState;
  readonly hands: readonly (readonly Card[])[];
  readonly tricks: readonly TrickView[];
  readonly error: string | null;
  /** 本局的级牌与主花色，用来把牌从大到小排 */
  readonly ctx: { level: number; trumpSuit: GameState['trumpSuit'] };
}

/** 本局出牌时的级牌和主花色（局终状态里这两项可能已经换成下一局的） */
function roundCtx(replay: RoundReplay): Rebuilt['ctx'] {
  let s = replay.initial;
  for (const a of replay.actions) {
    const r = applyAction(s, a);
    if (!r.ok) break;
    s = r.state;
    if (s.phase === 'playing') return { level: s.level, trumpSuit: s.trumpSuit };
  }
  return { level: s.level, trumpSuit: s.trumpSuit };
}

function rebuild(replay: RoundReplay): Rebuilt {
  let s = replay.initial;
  let hands: readonly (readonly Card[])[] | null = null;
  const tricks: TrickView[] = [];
  let revealed: Seat[] = [];
  let throwFailed: Seat[] = [];
  let error: string | null = null;
  for (const a of replay.actions) {
    const r = applyAction(s, a);
    if (!r.ok) { error = `${a.type}: ${r.error.message}`; break; }
    // 起手牌：找朋友在叫完朋友时记下；四人对家没有叫朋友，扣完底就记下
    const handsReady = a.type === 'callFriend' || (a.type === 'exchangeBottom' && r.state.config.friendCount === 0);
    if (handsReady && !hands) {
      hands = r.state.hands.map((h) => sortCardsDesc(h, { level: r.state.level, trumpSuit: r.state.trumpSuit }));
    }
    for (const e of r.events) {
      if (e.type === 'friendRevealed') revealed.push(e.seat);
      if (e.type === 'throwFailed') throwFailed.push(e.seat);
      if (e.type === 'trickWon') {
        const t = r.state.tricks[r.state.tricks.length - 1]!;
        tricks.push({ no: r.state.tricks.length, leader: t.leader, winner: t.winner, points: t.points, plays: t.plays, revealed, throwFailed });
        revealed = [];
        throwFailed = [];
      }
    }
    s = r.state;
  }
  return { final: s, hands: hands ?? s.hands, tricks, error, ctx: roundCtx(replay) };
}

export function Replay({ replay, onClose }: { replay: RoundReplay; onClose: () => void }) {
  const built = useMemo(() => rebuild(replay), [replay]);
  const [showHands, setShowHands] = useState(false);
  const name = (seat: Seat) => replay.names[seat] ?? `${seat + 1} 号`;
  const st = built.final;
  const team = st.dealer === null ? [] : [st.dealer, ...st.friends];
  const roleCls = (seat: Seat) => (seat === st.dealer ? 'dealer' : team.includes(seat) ? 'friend' : 'opp');
  const roleTxt = (seat: Seat) => (seat === st.dealer ? '庄' : team.includes(seat) ? '友' : '闲');
  return (
    <Modal title={`第 ${replay.round} 局回放`} onClose={onClose} className="replay">
        <div className="hint">
          级牌 {rankName(built.ctx.level)} · 主 <TrumpLabel suit={built.ctx.trumpSuit} /> · 庄家 {st.dealer === null ? '—' : name(st.dealer)}
          {st.friendCalls.length > 0 && <> · 朋友牌 {st.friendCalls.map((c, i) => <span key={`${c.suit}${c.rank}#${c.nth}`}>{i > 0 && '、'}第{['一', '二', '三'][c.nth - 1]}张 <CardNotation suit={c.suit} rank={c.rank} /></span>)}</>}
        </div>
        {built.error && <div className="hint warn">回放中断：{built.error}</div>}
        <button className="ghost small" onClick={() => setShowHands((v) => !v)}>{showHands ? '收起起手牌' : '查看各人起手牌'}</button>
        {showHands && (
          <div className="replay-hands">
            {built.hands.map((h, seat) => (
              <div key={seat} className="replay-hand">
                <div className="rp-seat"><span className={`role ${roleCls(seat)}`}>{roleTxt(seat)}</span>{name(seat)}</div>
                <div className="rp-cards"><CardRow cards={h} small /></div>
              </div>
            ))}
            {st.bottom.length > 0 && (
              <div className="replay-hand">
                <div className="rp-seat">底牌</div>
                <div className="rp-cards"><CardRow cards={sortCardsDesc(st.bottom, built.ctx)} small /></div>
              </div>
            )}
          </div>
        )}
        <div className="tricks">
          {built.tricks.map((t) => (
            <div key={t.no} className="trick">
              <div className="trick-head">
                <span className="trick-no">第 {t.no} 墩</span>
                <span>{name(t.winner)} 收{t.points ? `，${t.points} 分` : ''}</span>
                {t.revealed.map((r) => <span key={r} className="tag">{name(r)} 现身</span>)}
                {t.throwFailed.map((r) => <span key={`f${r}`} className="tag">{name(r)} 甩牌失败</span>)}
              </div>
              <div className="trick-plays">
                {t.plays.map((p) => (
                  <div key={p.seat} className={`trick-play ${p.seat === t.winner ? 'won' : ''} ${p.seat === t.leader ? 'led' : ''}`}>
                    <div className="tp-name"><span className={`role ${roleCls(p.seat)}`}>{roleTxt(p.seat)}</span>{name(p.seat)}</div>
                    <CardRow cards={sortCardsDesc(p.cards, built.ctx)} small />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
    </Modal>
  );
}
