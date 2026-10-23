import { useEffect, useState } from 'react';
import type { GameClient } from '../ws.ts';
import { buildTime } from '../pwa.ts';
import { AccountSheet, type AccountSheetMode } from '../components/AccountSheet.tsx';

/** 开房可选的玩法：人数决定玩法 */
const MODES: readonly { players: 3 | 4 | 5 | 6; label: string }[] = [
  { players: 3, label: '斗地主' },
  { players: 4, label: '对家升级' },
  { players: 5, label: '找 1 个朋友' },
  { players: 6, label: '找 2 个朋友' },
];

export function Home({ client }: { client: GameClient }) {
  const [name, setName] = useState(client.name);
  const [code, setCode] = useState(() => (new URLSearchParams(location.search).get('room') ?? '').toUpperCase().slice(0, 4));
  const [players, setPlayers] = useState<3 | 4 | 5 | 6>(6);
  const [sheet, setSheet] = useState<AccountSheetMode | null>(null);
  const ready = name.trim().length > 0;
  // 登录、改显示名字、退出登录后名字跟着变
  useEffect(() => { setName(client.name); }, [client.name]);

  // 已登记名字后，每 4 秒刷新一次服务器上的房间
  useEffect(() => {
    if (!client.connected || !client.name) return;
    client.send({ t: 'listRooms' });
    const t = setInterval(() => client.send({ t: 'listRooms' }), 4000);
    return () => clearInterval(t);
  }, [client.connected, client.name]);

  const phaseText = (r: NonNullable<typeof client.rooms>[number]) => {
    if (!r.started) return '等人中';
    if (r.game === 'doudizhu') return `斗地主第 ${r.round} 局${r.phase === 'bidding' ? ' 叫分' : r.phase === 'roundEnd' ? ' 结算' : ''}`;
    switch (r.phase) {
      case 'dealing': case 'declaring': return `第 ${r.round} 局 发牌`;
      case 'bottom': case 'callFriend': return `第 ${r.round} 局 扣底`;
      case 'playing': return `第 ${r.round} 局 打牌中`;
      case 'roundEnd': return `第 ${r.round} 局 结算`;
      case 'gameOver': return '已结束';
      default: return `第 ${r.round} 局`;
    }
  };

  // 登录后名字就是账号的显示名字，不用再登记
  const ensureName = () => {
    if (!client.account && name.trim() !== client.name) client.setName(name);
  };

  return (
    <div className="page-bg">
      <div className="home">
        <header className="home-head">
          <h1>升级<span>·</span>找朋友</h1>
          <p className="sub">找朋友 · 四人对家升级 · 三人斗地主</p>
        </header>
        <div className="home-main">
          {client.account ? (
            <div className="account-bar">
              <div className="account-who">
                <span className="account-label">已登录</span>
                <b>{client.account.displayName}</b>
                <span className="hint">登录名 {client.account.username}</span>
              </div>
              <div className="account-btns">
                <button className="ghost small" onClick={() => setSheet('settings')}>账号设置</button>
                {client.account.isAdmin && <button className="ghost small" onClick={() => setSheet('admin')}>管理账号</button>}
              </div>
            </div>
          ) : (
            <>
              <div className="account-bar">
                <div className="account-who">
                  <span className="account-label guest">游客</span>
                  <span className="hint">不登录也能玩；注册后换设备也能接着打，名字别人不能用</span>
                </div>
                <div className="account-btns">
                  <button className="ghost" onClick={() => setSheet('login')}>登录</button>
                  <button className="primary" onClick={() => setSheet('register')}>注册</button>
                </div>
              </div>
              <label className="field">
                <span>你的名字</span>
                <input value={name} maxLength={12} placeholder="比如 小赵" onChange={(e) => setName(e.target.value)} onBlur={ensureName} />
              </label>
            </>
          )}
          <div className="panel">
            <div className="panel-title">开房</div>
            <div className="modes">
              {MODES.map((m) => (
                <button key={m.players} className={players === m.players ? 'on' : ''} onClick={() => setPlayers(m.players)}>
                  <b>{m.players} 人</b><span>{m.label}</span>
                </button>
              ))}
            </div>
            <div className="hint">{players === 3 ? '一副牌，每人 17 张，留 3 张底牌。叫 1、2、3 分抢地主，地主拿底牌先出，两个农民一伙。炸弹、王炸、春天翻倍，一直打，累计积分。' : players === 4 ? '两副牌，每人 25 张，底牌 8 张，40 分一级、80 分下庄，对家固定一队。从 2 打到 A，5、10、K 必打且庄上过（停在这几级时要坐庄守住才能往上升），在 A 上坐庄守住才赢。' : '三副牌，找朋友：庄家扣底后叫朋友牌，谁打出谁就是自己人。'}</div>
            <button className="primary" disabled={!ready} onClick={() => { ensureName(); setTimeout(() => client.send({ t: 'createRoom', players }), 50); }}>
              创建房间
            </button>
          </div>
          <div className="panel">
            <div className="panel-title">加入</div>
            <div className="hint">房间已开局也能进，会接管机器人的座位；没有机器人座位就进去观看</div>
            <div className="row">
              <input className="code" value={code} maxLength={4} placeholder="房间码" onChange={(e) => setCode(e.target.value.toUpperCase())} />
              <button className="primary" disabled={!ready || code.length !== 4} onClick={() => { ensureName(); setTimeout(() => client.send({ t: 'joinRoom', code }), 50); }}>
                进入
              </button>
            </div>
          </div>
        </div>
        <div className="home-side">
          {client.name ? (
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
                      {r.started && (
                        <button className="ghost small" onClick={() => { ensureName(); setTimeout(() => client.send({ t: 'joinRoom', code: r.code, watch: true }), 50); }}>观看</button>
                      )}
                      {r.canClose && (
                        <button className="ghost small danger" onClick={() => { if (confirm(`关闭房间 ${r.code}？里面的牌局会被删除。`)) client.send({ t: 'closeRoom', code: r.code }); }}>关闭</button>
                      )}
                    </div>
                  </div>
                  <div className="room-main">
                    <span className="room-meta">{r.players} 人 · {phaseText(r)}</span>
                    <span className="room-meta">房主 {r.hostName}</span>
                    <span className="room-names">{r.names.join('、')}{r.bots ? `${r.names.length ? '、' : ''}机器人×${r.bots}` : ''}{r.humansOnline < r.humans ? ` · ${r.humans - r.humansOnline} 人离线` : ''}{r.spectators > 0 ? ` · ${r.spectators} 人观看` : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel">
              <div className="panel-title">服务器上的房间</div>
              <div className="hint">填好名字后，这里会列出服务器上正在打的房间，可以进去接管机器人或者观看。</div>
            </div>
          )}
        </div>
        <div className="build">版本 {buildTime}</div>
      </div>
      {sheet && <AccountSheet client={client} mode={sheet} onMode={setSheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
