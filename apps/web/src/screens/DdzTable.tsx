/** 三人斗地主的牌桌：叫分、出牌、结算。观看者跟着一个座位看，点头像换人。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DDZ_COMBO_NAME, ddzChoosePlay, ddzComboFor, ddzContextOfView, ddzFollowOptions,
  type DdzPlay, type Seat,
} from '@shengji/engine';
import type { ClientMessage } from '@shengji/protocol';
import { CardRow, CardView } from '../components/CardView.tsx';
import { Avatar } from '../avatar.tsx';
import { sound } from '../sound.ts';
import type { GameClient } from '../ws.ts';

interface Pos { x: number; y: number }
/** 出牌逆时针：下家在右手边，上家在左手边 */
const SEAT_POS: readonly Pos[] = [{ x: 89, y: 40 }, { x: 11, y: 40 }];
const PLAY_POS: readonly Pos[] = [{ x: 70, y: 44 }, { x: 30, y: 44 }];
const ME_PLAY: Pos = { x: 50, y: 78 };
const pct = (p: Pos): React.CSSProperties => ({ left: `${p.x}%`, top: `${p.y}%` });

export function DdzTable({ client }: { client: GameClient }) {
  const view = client.ddzView!;
  const room = client.room!;
  // 观看者（没坐下）的 me 是正在看的那个座位，只能看不能操作
  const me = view.seat;
  const spectating = room.you === null;
  const send = (m: ClientMessage) => { sound.unlock(); client.send(m); };
  const name = (s: Seat) => room.seats[s]?.name ?? `${s + 1} 号`;
  const [selected, setSelected] = useState<string[]>([]);
  const [hintAt, setHintAt] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(sound.enabled);

  const myTurn = !spectating && view.turn === me && view.phase !== 'roundEnd';
  const free = view.phase === 'playing' && (!view.lastPlay || view.lastPlay.seat === me);
  const lead = !free && view.lastPlay ? view.lastPlay.combo : null;
  const selectedCards = useMemo(() => view.hand.filter((c) => selected.includes(c.id)), [view.hand, selected]);
  const combo = selectedCards.length > 0 ? ddzComboFor(selectedCards, lead) : null;
  const options = useMemo(() => (myTurn && lead ? ddzFollowOptions(view.hand, lead) : []), [myTurn, lead, view.hand]);

  // 手牌变了清掉失效的选择；换人出牌后提示从头开始
  useEffect(() => { setSelected((sel) => sel.filter((id) => view.hand.some((c) => c.id === id))); }, [view.hand]);
  useEffect(() => { setHintAt(0); }, [view.turn, view.lastPlay]);

  // 事件：闪现文字 + 音效
  useEffect(() => {
    const texts: string[] = [];
    for (const e of client.ddzEvents) {
      switch (e.type) {
        case 'dealt': texts.push(`第 ${view.round} 局，${name(e.firstBidder)} 先叫`); break;
        case 'bid': texts.push(`${name(e.seat)} ${e.points ? `叫 ${e.points} 分` : '不叫'}`); break;
        case 'redeal': texts.push('都不叫，重新发牌'); break;
        case 'landlord': texts.push(`${name(e.seat)} 当地主，底分 ${e.bid}`); sound.bark(); break;
        case 'played':
          if (e.combo === 'bomb' || e.combo === 'rocket') { texts.push(`${name(e.seat)} ${DDZ_COMBO_NAME[e.combo]}！`); sound.bark(); } else sound.tick();
          break;
        case 'roundEnd': if (e.result.landlordWon === (e.result.landlord === me)) sound.win(); break;
        default: break;
      }
    }
    if (texts.length === 0) return;
    setFlash(texts[texts.length - 1] as string);
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [client.ddzEvents]);

  const prevTurn = useRef(false);
  useEffect(() => {
    if (myTurn && !prevTurn.current) sound.turn();
    prevTurn.current = myTurn;
  }, [myTurn]);

  const toggle = (id: string) => {
    sound.unlock();
    if (spectating) return;
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const hint = () => {
    if (free) {
      const c = ddzChoosePlay(ddzContextOfView(view));
      if (c) setSelected(c.cards.map((x) => x.id));
      return;
    }
    if (options.length === 0) return;
    const o = options[hintAt % options.length]!;
    setSelected(o.cards.map((x) => x.id));
    setHintAt(hintAt + 1);
  };
  const play = () => { send({ t: 'ddzPlay', cards: selected }); setSelected([]); };

  const roleText = (s: Seat) => (view.landlord === null ? null : s === view.landlord ? '地主' : '农民');
  /** 这一轮某人最近的动作：出的牌或「不出」 */
  const lastAction = (s: Seat): DdzPlay | null => {
    for (let i = view.roundPlays.length - 1; i >= 0; i--) if (view.roundPlays[i]!.seat === s) return view.roundPlays[i]!;
    return null;
  };
  const opps: Seat[] = [(me + 1) % 3, (me + 2) % 3];

  let status: string;
  if (view.phase === 'bidding') {
    const now = view.bid ? `，现在 ${view.bid} 分` : '';
    status = myTurn ? `轮到你叫分${now}` : `等 ${name(view.turn)} 叫分${now}`;
  } else if (view.phase === 'playing') {
    status = myTurn ? (free ? '轮到你出牌' : options.length ? '轮到你，管得住就出' : '要不起') : `等 ${name(view.turn)} 出牌`;
  } else {
    status = '本局结束';
  }

  let playHint: string | null = null;
  if (myTurn && view.phase === 'playing' && selectedCards.length > 0) {
    playHint = combo ? DDZ_COMBO_NAME[combo.type] : lead ? '管不住' : '不是能出的牌型';
  }

  /** 某个座位这一轮的动作：叫分时显示叫的分，出牌时显示出的牌或「不出」 */
  const actionAt = (s: Seat, pos: Pos) => {
    if (view.phase === 'bidding') {
      const b = view.bids[s];
      if (b === null || b === undefined) return null;
      return <div key={`a${s}`} className="ddz-act text" style={pct(pos)}>{b ? `${b} 分` : '不叫'}</div>;
    }
    const a = lastAction(s);
    if (!a) return null;
    if (!a.combo) return <div key={`a${s}`} className="ddz-act text" style={pct(pos)}>不出</div>;
    return (
      <div key={`a${s}`} className="ddz-act" style={pct(pos)}>
        <CardRow cards={a.combo.cards} small />
        <span className="ddz-combo">{DDZ_COMBO_NAME[a.combo.type]}</span>
      </div>
    );
  };

  return (
    <div className="table ddz">
      <div className="rotate-cover"><div className="rotate-icon">⟲</div><div>请把手机横过来</div><div className="hint">牌桌按横屏设计</div></div>
      <header className="topbar">
        <span className="tb-item tb-code" title="房间码">房 <b>{room.code}</b></span>
        <span className="tb-item">第 {view.round} 局</span>
        <span className="tb-item">底分 <b>{view.bid || '-'}</b></span>
        <span className="tb-item">倍数 <b>×{view.multiple}</b>{view.bombs > 0 ? ` · 炸 ${view.bombs}` : ''}</span>
        <span className="tb-item">积分 <b>{view.scores[me] ?? 0}</b></span>
        {(spectating || room.spectators.length > 0) && (
          <span className="tb-item" title={room.spectators.join('、')}>{spectating ? '观看中' : `${room.spectators.length} 人观看`}</span>
        )}
        <button className={`tb-item tb-click tb-sound ${soundOn ? '' : 'off'}`} onClick={() => setSoundOn(sound.toggle())} aria-label="音效">{soundOn ? '🔊 音效' : '🔇 静音'}</button>
        <button className={`tb-menu ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen((v) => !v)} aria-label="菜单" aria-expanded={menuOpen}>⋯ 菜单</button>
      </header>
      {menuOpen && (
        <div className="host-menu">
          {room.youAreHost && (
            <>
              <button className="ghost small danger" onClick={() => {
                setMenuOpen(false);
                if (confirm('结束游戏回到大厅？积分清零，座位保留。')) send({ t: 'abortGame' });
              }}>结束游戏</button>
              <button className="ghost small danger" onClick={() => {
                setMenuOpen(false);
                if (confirm(`关闭房间 ${room.code}？牌局删除，所有人回到首页。`)) send({ t: 'closeRoom' });
              }}>关闭房间</button>
            </>
          )}
          <button className="ghost small danger" onClick={() => {
            setMenuOpen(false);
            if (spectating) { send({ t: 'leaveRoom' }); return; }
            if (confirm(`退出本局？你的座位由机器人接管。之后用房间码 ${room.code} 重新进入可以接回机器人的座位。`)) send({ t: 'leaveRoom' });
          }}>{spectating ? '退出观看' : '退出本局'}</button>
          <button className="ghost small" onClick={() => setMenuOpen(false)}>取消</button>
        </div>
      )}

      <section className="felt">
        <div className="felt-ring" />
        {/* 三张底牌：定了地主后亮给所有人 */}
        <div className="ddz-bottom" style={pct({ x: 50, y: 12 })}>
          {view.bottom ? <CardRow cards={view.bottom} small /> : <div className="ddz-backs"><span /><span /><span /></div>}
        </div>
        {opps.map((s, i) => {
          const slot = room.seats[s];
          const count = view.handCounts[s] ?? 0;
          const role = roleText(s);
          return (
            <div
              key={s}
              className={`badge ${view.turn === s && view.phase !== 'roundEnd' ? 'turn' : ''} ${spectating ? 'watchable' : ''}`}
              style={pct(SEAT_POS[i]!)}
              onClick={spectating ? () => send({ t: 'watch', seat: s }) : undefined}
              title={spectating ? `看 ${name(s)} 的牌` : undefined}
            >
              <span className="b-avatar"><Avatar name={name(s)} isBot={Boolean(slot?.isBot)} size={40} />{role && <span className={`role role-dot ${role === '地主' ? 'dealer' : 'opp'}`}>{role === '地主' ? '地' : '农'}</span>}</span>
              <span className="b-name">{name(s)}</span>
              <span className="b-meta">
                <span className="b-count">{count}</span>
                {view.phase === 'playing' && count <= 2 && <span className="b-pass">{count === 1 ? '报单' : '报双'}</span>}
                <span className="b-level">{view.scores[s] ?? 0} 分</span>
                {slot && !slot.connected && <span className="b-off">离线</span>}
              </span>
            </div>
          );
        })}
        {opps.map((s, i) => actionAt(s, PLAY_POS[i]!))}
        {actionAt(me, ME_PLAY)}
        <div className="center-msg" style={pct({ x: 50, y: 32 })}>
          <div className={`status ${flash ? 'flash' : ''}`}>{flash ?? status}</div>
        </div>
      </section>

      <section className="me">
        <div className="me-head">
          {roleText(me) && <span className={`role ${roleText(me) === '地主' ? 'dealer' : 'opp'}`}>{roleText(me) === '地主' ? '地' : '农'}</span>}
          <span className="b-name">{name(me)}</span>
          <span className="b-count">{view.hand.length}</span>
          <span className="b-level">{view.scores[me] ?? 0} 分</span>
          {playHint && <span className="play-hint">{playHint}</span>}
          {selected.length > 0 && <button className="ghost tiny" onClick={() => setSelected([])}>清除</button>}
        </div>
        <div className="hand">
          <div className="hand-row" style={{ ['--n' as string]: view.hand.length } as React.CSSProperties}>
            {view.hand.map((c) => (
              <CardView key={c.id} card={c} selected={selected.includes(c.id)} onClick={() => toggle(c.id)} />
            ))}
          </div>
        </div>
        <div className="actions">
          {spectating ? (
            <div className="spectate-note">观看中<br />点头像换着看每个人的牌</div>
          ) : view.phase === 'bidding' && myTurn ? (
            <div className="action-row">
              <button className="ghost" onClick={() => send({ t: 'bid', points: 0 })}>不叫</button>
              {[1, 2, 3].map((p) => (
                <button key={p} className="primary" disabled={p <= view.bid} onClick={() => send({ t: 'bid', points: p })}>{p} 分</button>
              ))}
            </div>
          ) : view.phase === 'playing' ? (
            <>
              <div className="action-row">
                <button className="ghost" disabled={!myTurn || free} onClick={() => { send({ t: 'ddzPass' }); setSelected([]); }}>不出</button>
                <button className="ghost" disabled={!myTurn || (!free && options.length === 0)} onClick={hint}>提示</button>
              </div>
              <button className={`primary ${myTurn ? 'pulse' : ''}`} disabled={!myTurn || !combo} onClick={play}>出牌{selected.length ? ` ${selected.length} 张` : ''}</button>
            </>
          ) : null}
        </div>
      </section>

      {view.phase === 'roundEnd' && view.lastRound && <DdzRoundEnd client={client} />}
    </div>
  );
}

/** 一局结算：谁赢、底分 × 倍数、每人得失和累计积分、各人剩下的牌 */
function DdzRoundEnd({ client }: { client: GameClient }) {
  const view = client.ddzView!;
  const room = client.room!;
  const r = view.lastRound!;
  const name = (s: Seat) => room.seats[s]?.name ?? `${s + 1} 号`;
  const iWon = room.you !== null && (room.you === r.landlord) === r.landlordWon;
  const why = [r.bombs > 0 ? `炸弹 ${r.bombs} 个` : '', r.spring === 'spring' ? '春天' : r.spring === 'antiSpring' ? '反春' : ''].filter(Boolean).join('、');
  return (
    <div className="overlay">
      <div className="sheet">
        <div className="sheet-title">第 {view.round} 局结算</div>
        <div className={`result-line ${iWon ? 'win' : ''}`}>
          {r.landlordWon ? `地主 ${name(r.landlord)} 赢了` : '农民赢了'}
          {r.spring === 'spring' ? '，春天！' : r.spring === 'antiSpring' ? '，反春！' : ''}
          {room.you !== null ? (iWon ? '，你赢了' : '，你输了') : ''}
        </div>
        <table className="result-table">
          <tbody>
            <tr><td>地主</td><td>{name(r.landlord)}</td></tr>
            <tr><td>底分</td><td>{r.bid}</td></tr>
            <tr><td>倍数</td><td>×{r.multiple}{why ? `（${why}）` : ''}</td></tr>
          </tbody>
        </table>
        <div className="label">得分</div>
        <div className="levels">
          {[0, 1, 2].map((s) => {
            const d = r.deltas[s] ?? 0;
            return (
              <div key={s} className={`lv-row ${d > 0 ? 'up' : ''}`}>
                <span className={`role ${s === r.landlord ? 'dealer' : 'opp'}`}>{s === r.landlord ? '地' : '农'}</span>
                <span>{name(s)}</span>
                <span className="pts">{d > 0 ? '+' : ''}{d}</span>
                <span className="lv">共 {view.scores[s] ?? 0}</span>
              </div>
            );
          })}
        </div>
        {r.hands.some((h) => h.length > 0) && (
          <>
            <div className="label">剩下的牌</div>
            {[0, 1, 2].filter((s) => (r.hands[s]?.length ?? 0) > 0).map((s) => (
              <div key={s} className="ddz-left"><span>{name(s)}</span><CardRow cards={r.hands[s]!} small /></div>
            ))}
          </>
        )}
        <div className="sheet-actions">
          {room.you !== null && (
            <button className="ghost danger" onClick={() => {
              if (confirm(`退出本局？你的座位由机器人接管。之后用房间码 ${room.code} 重新进入可以接回机器人的座位。`)) client.send({ t: 'leaveRoom' });
            }}>退出</button>
          )}
          {room.youAreHost ? <button className="primary" onClick={() => client.send({ t: 'nextRound' })}>下一局</button> : <div className="hint">等待房主开始下一局</div>}
        </div>
      </div>
    </div>
  );
}
