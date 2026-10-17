import { useState } from 'react';
import type { GameClient } from '../ws.ts';
import { Avatar } from '../avatar.tsx';
import { PageChrome } from '../components/PageChrome.tsx';
import { Modal } from '../components/Modal.tsx';

export function Lobby({ client }: { client: GameClient }) {
  const room = client.room!;
  const full = room.seats.every(s => s);
  const missing = room.seats.filter(s => !s).length;
  const [menu, setMenu] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const shareUrl = `${location.origin}/?room=${room.code}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(`来打找朋友：${shareUrl} 房间码 ${room.code}`); setCopyStatus('邀请链接已复制。'); }
    catch { setCopyStatus(`复制失败，请手动分享房间码 ${room.code}。`); }
  };
  return <main className="lobby page">
    <PageChrome title={`等候房 · ${room.code}`} onBack={() => client.send({ t: 'leaveRoom' })}><button className="ghost" onClick={() => setMenu(true)}>更多操作 ···</button></PageChrome>
    <div className="lobby-layout panel">
      <section>
        <div className="lobby-title"><div><h1>{full ? '玩家已到齐' : '等待玩家入座'}</h1><p className="hint">{room.players} 人{room.players === 4 ? '固定对家 · 两副牌' : '找朋友 · 三副牌'}</p></div><div className="code-tag" aria-label={`房间码 ${room.code}`}>{room.code}</div></div>
        <div className="lobby-table" aria-label="房间座位">
          <div className="lobby-oval"><b>{room.players - missing} / {room.players} 已入座</b><span>{missing > 0 ? `还差 ${missing} 人` : room.youAreHost ? '可以开始' : '等待房主开始'}</span></div>
          {room.seats.map((s, i) => {
            // Start at the viewer's seat; the next seat is to their right (counterclockwise).
            const relative = (i - (room.you ?? 0) + room.players) % room.players;
            const angle = Math.PI / 2 - 2 * Math.PI * relative / room.players;
            return <div key={i} className={`lobby-person ${room.you === i ? 'is-me' : ''}`} style={{ left: `${50 + 40 * Math.cos(angle)}%`, top: `${50 + 36 * Math.sin(angle)}%` }}>
              {s ? <><Avatar name={s.name} isBot={s.isBot} size={44} /><strong>{s.name}</strong><small>{s.isHost ? '房主' : s.isBot ? '机器人' : '已就座'} · {i + 1} 号位{s.connected ? '' : ' · 离线'}</small>{room.you === i && <button className="ghost small" disabled={!client.connected} onClick={() => client.send({ t: 'stand' })}>起立</button>}{room.youAreHost && s.isBot && <button className="ghost small" disabled={!client.connected} onClick={() => client.send({ t: 'removeBot', seat: i })}>移除</button>}</> : <><span className="empty-seat" aria-hidden="true">+</span><strong>空座</strong><small>{i + 1} 号位</small><div className="seat-actions"><button className="ghost small" disabled={!client.connected} onClick={() => client.send({ t: 'sit', seat: i })}>坐下</button>{room.youAreHost && <button className="ghost small" disabled={!client.connected} aria-label={`为 ${i + 1} 号位加机器人`} onClick={() => client.send({ t: 'addBot', seat: i })}>机器人</button>}</div></>}
            </div>;
          })}
        </div>
        <p className="lobby-bottom hint">从你右手边开始，按座位号逆时针出牌</p>
      </section>
      <aside className="lobby-settings"><h2>房间设置</h2><div className="detail-row"><span>玩法</span><b>{room.players === 4 ? '固定对家' : `找 ${room.players - 4} 位朋友`}</b></div><div className="detail-row"><span>牌组</span><b>{room.players === 4 ? '两副 · 108 张' : '三副 · 162 张'}</b></div><div className="field-label" id="bots-label">机器人难度</div><div className="seg" role="group" aria-labelledby="bots-label">{(['normal', 'strong'] as const).map(strength => <button key={strength} className={room.botStrength === strength ? 'on' : ''} aria-pressed={room.botStrength === strength} disabled={!room.youAreHost || !client.connected} onClick={() => client.send({ t: 'setBots', strength })}>{strength === 'normal' ? '普通 · 反应快' : '加强 · 会算牌'}</button>)}</div><p className="hint">{room.botStrength === 'strong' ? '加强：会记牌，出牌稍慢。' : '普通：出牌更快。'}空座可由机器人补位。{!room.youAreHost && '只有房主能调整。'}</p><p className="hint avatar-credit">机器人头像采用维基百科自由授权照片。</p></aside>
    </div>
    <div className="action-bar lobby-actions"><div className="secondary-actions"><button className="ghost" onClick={copy}>复制邀请</button>{room.youAreHost && <button className="ghost" disabled={full || !client.connected} onClick={() => room.seats.forEach((s, seat) => { if (!s) client.send({ t: 'addBot', seat }); })}>机器人补位</button>}</div>{room.youAreHost ? <button className="primary" disabled={!full || !client.connected} onClick={() => client.send({ t: 'start' })}>{full ? '开始游戏 →' : `还差 ${missing} 人`}</button> : <span className="hint">等待房主开始</span>}</div>
    <p className="hint copy-status" role="status">{copyStatus}</p>
    {menu && <Modal title="房间操作" onClose={() => setMenu(false)}><p>房间码 {room.code} · {room.players} 人局</p><div className="sheet-actions">{room.youAreHost && <button className="ghost danger" disabled={!client.connected} onClick={() => { if (confirm(`关闭房间 ${room.code}？所有人都会回到首页。`)) client.send({ t: 'closeRoom' }); }}>关闭房间</button>}<button className="ghost" onClick={() => client.send({ t: 'leaveRoom' })}>离开房间</button><button className="primary" onClick={() => setMenu(false)}>继续等候</button></div></Modal>}
  </main>;
}
