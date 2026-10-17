import { useEffect, useState } from 'react';
import type { GameClient } from '../ws.ts';
import { buildTime } from '../pwa.ts';

export function Home({ client }: { client: GameClient }) {
  const [name, setName] = useState(client.name);
  const [code, setCode] = useState(() => (new URLSearchParams(location.search).get('room') ?? '').toUpperCase().slice(0, 4));
  const [players, setPlayers] = useState<4 | 5 | 6>(6);
  const ready = name.trim().length > 0;

  // 已登记名字后，每 4 秒刷新一次服务器上的房间
  useEffect(() => {
    if (!client.connected || !client.name) return;
    client.send({ t: 'listRooms' });
    const t = setInterval(() => client.send({ t: 'listRooms' }), 4000);
    return () => clearInterval(t);
  }, [client.connected, client.name]);

  const phaseText = (r: NonNullable<typeof client.rooms>[number]) => {
    if (!r.started) return '等人中';
    switch (r.phase) {
      case 'dealing': case 'declaring': return `第 ${r.round} 局 发牌`;
      case 'bottom': case 'callFriend': return `第 ${r.round} 局 扣底`;
      case 'playing': return `第 ${r.round} 局 打牌中`;
      case 'roundEnd': return `第 ${r.round} 局 结算`;
      case 'gameOver': return '已结束';
      default: return `第 ${r.round} 局`;
    }
  };

  const ensureName = () => {
    if (name.trim() !== client.name) client.setName(name);
  };

  return (
    <div className="home">
      <h1>升级<span>·</span>找朋友</h1>
      <p className="sub">三副牌 · 5 或 6 人 · 找朋友</p>
      <label className="field">
        <span>你的名字</span>
        <input value={name} maxLength={12} placeholder="比如 小赵" onChange={(e) => setName(e.target.value)} onBlur={ensureName} />
      </label>
      <div className="panel">
        <div className="panel-title">开房</div>
        <div className="seg">
          <button className={players === 4 ? 'on' : ''} onClick={() => setPlayers(4)}>4 人 · 对家</button>
          <button className={players === 5 ? 'on' : ''} onClick={() => setPlayers(5)}>5 人 · 1 个朋友</button>
          <button className={players === 6 ? 'on' : ''} onClick={() => setPlayers(6)}>6 人 · 2 个朋友</button>
        </div>
        <div className="hint">{players === 4 ? '两副牌，每人 25 张，底牌 8 张，40 分一级、80 分下庄，对家固定一队。从 2 打到 A，5、10、K 必打且庄上过（停在这几级时要坐庄守住才能往上升），在 A 上坐庄守住才赢。' : '三副牌，找朋友：庄家扣底后叫朋友牌，谁打出谁就是自己人。'}</div>
        <button className="primary" disabled={!ready} onClick={() => { ensureName(); setTimeout(() => client.send({ t: 'createRoom', players }), 50); }}>
          创建房间
        </button>
      </div>
      <div className="panel">
        <div className="panel-title">加入</div>
        <div className="hint">房间已开局也能进，会接管机器人的座位</div>
        <div className="row">
          <input className="code" value={code} maxLength={4} placeholder="房间码" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <button className="primary" disabled={!ready || code.length !== 4} onClick={() => { ensureName(); setTimeout(() => client.send({ t: 'joinRoom', code }), 50); }}>
            进入
          </button>
        </div>
      </div>
      {client.name && (
        <div className="panel">
          <div className="panel-title">服务器上的房间</div>
          {client.rooms === null && <div className="hint">加载中…</div>}
          {client.rooms && client.rooms.length === 0 && <div className="hint">现在没有房间，开一个吧</div>}
          {client.rooms?.map((r) => (
            <div key={r.code} className="room-row">
              <div className="room-left">
                <span className="room-code">{r.code}</span>
                <div className="room-actions">
                  <button className="primary small" disabled={!r.joinable} onClick={() => { ensureName(); setTimeout(() => client.send({ t: 'joinRoom', code: r.code }), 50); }}>
                    {r.joinable ? (r.started ? '接管机器人' : '进入') : '已满'}
                  </button>
                  {r.canClose && (
                    <button className="ghost small danger" onClick={() => { if (confirm(`关闭房间 ${r.code}？里面的牌局会被删除。`)) client.send({ t: 'closeRoom', code: r.code }); }}>关闭</button>
                  )}
                </div>
              </div>
              <div className="room-main">
                <span className="room-meta">{r.players} 人 · {phaseText(r)}</span>
                <span className="room-meta">房主 {r.hostName}</span>
                <span className="room-names">{r.names.join('、')}{r.bots ? `${r.names.length ? '、' : ''}机器人×${r.bots}` : ''}{r.humansOnline < r.humans ? ` · ${r.humans - r.humansOnline} 人离线` : ''}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="build">版本 {buildTime}</div>
    </div>
  );
}
