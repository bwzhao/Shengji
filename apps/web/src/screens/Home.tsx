import { useEffect, useState } from 'react';
import type { GameClient } from '../ws.ts';
import { PageChrome } from '../components/PageChrome.tsx';
import { SUIT_GLYPH } from '../components/SuitText.tsx';
import { CardView } from '../components/CardView.tsx';

export function Home({ client }: { client: GameClient }) {
  const [name, setName] = useState(client.name);
  const [code, setCode] = useState(() => (new URLSearchParams(location.search).get('room') ?? '').toUpperCase().slice(0, 4));
  const [players, setPlayers] = useState<4 | 5 | 6>(6);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!client.connected || !client.name) return;
    client.send({ t: 'listRooms' });
    const timer = setInterval(() => client.send({ t: 'listRooms' }), 4000);
    return () => clearInterval(timer);
  }, [client.connected, client.name]);
  const ensureName = () => { if (name.trim() !== client.name) client.setName(name); };
  const act = (action: () => void) => {
    if (!name.trim()) { setError('请先输入昵称。'); return; }
    setError(''); ensureName(); action();
  };
  const phaseText = (r: NonNullable<typeof client.rooms>[number]) => {
    if (!r.started) return '等人中';
    switch (r.phase) {
      case 'dealing': case 'declaring': return `第 ${r.round} 局 · 发牌亮主`;
      case 'bottom': case 'callFriend': return `第 ${r.round} 局 · 扣底叫朋友`;
      case 'playing': return `第 ${r.round} 局 · 打牌中`;
      case 'roundEnd': return `第 ${r.round} 局 · 结算`;
      case 'gameOver': return '已结束';
      default: return `第 ${r.round} 局`;
    }
  };
  return <main className="home page">
    <PageChrome title="游戏大厅" />
    <div className="home-grid">
      <section className="hero-copy">
        <h1>升级 · 找朋友</h1>
        <p className="intro">支持 4 人对家与 5 / 6 人找朋友。创建房间后，把房间码发给朋友即可加入。</p>
        <div className="hero-art" aria-hidden="true">
          {[{ suit: 'S' as const, rank: 14 }, { suit: 'H' as const, rank: 13 }, { suit: 'C' as const, rank: 14 }].map((c, i) => <CardView key={i} card={{ ...c, id: `art-${i}`, deck: 0 }} />)}
        </div>
      </section>
      <section className="panel create-panel">
        <div className="section-heading"><h2>创建房间</h2></div>
        <label className="field"><span>昵称</span><input value={name} maxLength={12} autoComplete="nickname" placeholder="输入昵称" onChange={e => setName(e.target.value)} onBlur={ensureName} aria-describedby="home-error" /></label>
        <div className="field-label" id="players-label">人数</div>
        <div className="seg modes" role="group" aria-labelledby="players-label">
          {([4, 5, 6] as const).map(n => <button key={n} className={players === n ? 'on' : ''} aria-pressed={players === n} onClick={() => setPlayers(n)}><b>{n} 人</b><small>{n === 4 ? '固定对家' : `找 ${n - 4} 位朋友`}</small></button>)}
        </div>
        <p className="hint">{players === 4 ? '两副牌 · 对家固定组队 · 从 2 打到 A' : '三副牌 · 打出朋友牌后才公开队友'}</p>
        <div className="action-bar"><button className="primary" disabled={!client.connected} onClick={() => act(() => client.send({ t: 'createRoom', players }))}>创建房间 →</button></div>
        <form className="join-form" onSubmit={e => { e.preventDefault(); act(() => { if (!/^[A-Z0-9]{4}$/.test(code)) setError('请输入 4 位字母或数字房间码。'); else client.send({ t: 'joinRoom', code }); }); }}>
          <label className="field" htmlFor="room-code"><span>加入房间</span></label>
          <div className="row"><input id="room-code" className="code" value={code} maxLength={4} placeholder="输入 4 位房间码" onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} aria-describedby="home-error" /><button className="ghost" disabled={!client.connected}>加入 →</button></div>
        </form>
        {error && <p id="home-error" className="form-error" role="alert">{error}</p>}
      </section>
    </div>
    <section className="rooms-section">
      <div className="section-heading"><h2>房间列表</h2><span className="hint">{client.rooms ? `${client.rooms.length} 桌` : ''}</span></div>
      {!client.name ? <div className="empty-state">输入昵称后显示房间列表。</div> : client.rooms === null ? <div className="room-loading" role="status">正在加载房间…</div> : client.rooms.length === 0 ? <div className="empty-state">暂无房间。创建房间后，把房间码发给朋友。</div> : client.rooms.map(r => <div key={r.code} className="room-row">
        <div className="room-name"><span className="room-monogram" aria-hidden="true">{SUIT_GLYPH.C}</span><div><b>{r.hostName}的牌桌</b><small>{r.code} · {r.players} 人{r.players === 4 ? '对家' : '找朋友'}</small></div></div>
        <div className="room-state"><span className="state-dot" />{phaseText(r)}</div>
        <div className="room-names">{r.names.join('、')}{r.bots ? ` · 机器人 × ${r.bots}` : ''}{r.humansOnline < r.humans ? ` · ${r.humans - r.humansOnline} 人离线` : ''}</div>
        <div className="room-actions"><button className="ghost" disabled={!r.joinable || !client.connected} onClick={() => act(() => client.send({ t: 'joinRoom', code: r.code }))}>{r.joinable ? (r.started ? '接替入座 →' : '加入 →') : '已满'}</button>{r.canClose && <button className="ghost danger small" disabled={!client.connected} onClick={() => { if (confirm(`关闭房间 ${r.code}？里面的牌局会被删除。`)) client.send({ t: 'closeRoom', code: r.code }); }}>关闭房间</button>}</div>
      </div>)}
    </section>
  </main>;
}
