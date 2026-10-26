import { useEffect, useState } from 'react';
import { zaofanRuleError, type RoomRules, type ZaofanRule } from '@shengji/protocol';
import type { GameClient } from '../ws.ts';
import { buildTime } from '../pwa.ts';
import { AccountSheet, type AccountSheetMode } from '../components/AccountSheet.tsx';
import { Avatar } from '../avatar.tsx';
import { defaultZaofan, RulesPicker, rulesNote } from '../components/RulesPicker.tsx';
import { QrCode } from '../components/QrCode.tsx';
import { Latency } from '../components/Latency.tsx';
import { useServerInfo } from '../serverInfo.ts';

/** 开房可选的玩法：人数决定玩法 */
const MODES: readonly { players: 3 | 4 | 5 | 6; label: string }[] = [
  { players: 3, label: '斗地主' },
  { players: 4, label: '对家升级' },
  { players: 5, label: '找 1 个朋友' },
  { players: 6, label: '找 2 个朋友' },
];

const RULES_KEY = 'shengji.rules';
/** 局域网版的下载页：每次合并到 main 自动重新打包 */
const LAN_DOWNLOAD = 'https://github.com/bwzhao/Shengji/releases/tag/lan-latest';

/** 浏览器记住的开房规则：抄底、过河一份，造反分数线每个人数一份（没记的用默认） */
interface SavedRules {
  readonly chaodi: boolean;
  readonly guohe: boolean;
  readonly zaofan: Partial<Record<4 | 5 | 6, ZaofanRule | null>>;
}

function loadRules(): SavedRules {
  try {
    const saved = JSON.parse(localStorage.getItem(RULES_KEY) ?? '{}') as Partial<SavedRules>;
    const zaofan: Partial<Record<4 | 5 | 6, ZaofanRule | null>> = {};
    for (const p of [4, 5, 6] as const) {
      const z = saved.zaofan?.[p];
      // 记下的分数线不合理就不要了
      if (z === null || (z && !zaofanRuleError(z, p))) zaofan[p] = z;
    }
    return { chaodi: saved.chaodi !== false, guohe: saved.guohe !== false, zaofan };
  } catch {
    return { chaodi: true, guohe: true, zaofan: {} };
  }
}

function rulesFor(saved: SavedRules, players: 4 | 5 | 6): RoomRules {
  const z = saved.zaofan[players];
  return { chaodi: players === 4 && saved.chaodi, guohe: players === 4 && saved.guohe, zaofan: z === undefined ? defaultZaofan(players) : z };
}

export function Home({ client }: { client: GameClient }) {
  const [name, setName] = useState(client.name);
  const [code, setCode] = useState(() => (new URLSearchParams(location.search).get('room') ?? '').toUpperCase().slice(0, 4));
  const [players, setPlayers] = useState<3 | 4 | 5 | 6>(6);
  const [sheet, setSheet] = useState<AccountSheetMode | null>(null);
  const [saved, setSaved] = useState<SavedRules>(loadRules);
  const info = useServerInfo();
  const rules = players === 3 ? null : rulesFor(saved, players);
  const rulesProblem = rules?.zaofan ? zaofanRuleError(rules.zaofan, players as 4 | 5 | 6) : null;
  const changeRules = (patch: Partial<RoomRules>) => {
    if (players === 3) return;
    const next: SavedRules = {
      chaodi: patch.chaodi ?? saved.chaodi,
      guohe: patch.guohe ?? saved.guohe,
      zaofan: patch.zaofan === undefined ? saved.zaofan : { ...saved.zaofan, [players]: patch.zaofan },
    };
    setSaved(next);
    try { localStorage.setItem(RULES_KEY, JSON.stringify(next)); } catch { /* 忽略 */ }
  };
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
                <Avatar name={client.account.displayName} isBot={false} src={client.account.avatar} size={32} />
                <b>{client.account.displayName}</b>
                <span className="account-label">已登录</span>
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
                  <span className="hint">不登录也能玩；注册后换设备也能接着打，名字别人不能用，还能上传头像</span>
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
            {players !== 3 && rules && <RulesPicker players={players} rules={rules} onChange={changeRules} />}
            <button className="primary" disabled={!ready || Boolean(rulesProblem)} onClick={() => { ensureName(); setTimeout(() => client.send({ t: 'createRoom', players, ...(rules ? { rules } : {}) }), 50); }}>
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
          {info?.lan && <LanPanel urls={info.lan} />}
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
                    <span className="room-meta">{r.players} 人 · {phaseText(r)}{rulesNote(r.rules, r.players)}</span>
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
        <div className="build">
          版本 {buildTime} · 网络延迟 <Latency ms={client.latency} />
          {info && !info.lan && <> · <a href={LAN_DOWNLOAD} target="_blank" rel="noreferrer">下载局域网版</a>（没有外网时，一台电脑开服务器，同一个 WiFi 一起玩）</>}
        </div>
      </div>
      {sheet && <AccountSheet client={client} mode={sheet} onMode={setSheet} onClose={() => setSheet(null)} />}
    </div>
  );
}

/** 局域网版：告诉房主别人用哪个地址进来 */
function LanPanel({ urls }: { urls: readonly string[] }) {
  const main = urls[0];
  return (
    <div className="panel lan-panel">
      <div className="panel-title">局域网模式</div>
      {main ? (
        <div className="lan-body">
          <QrCode text={main} />
          <div className="lan-text">
            <div>其他人连上和这台电脑同一个 WiFi，用手机相机扫码，或者在浏览器打开：</div>
            <b className="lan-url">{main}</b>
            {urls.length > 1 && <div className="hint">打不开的话试试：{urls.slice(1).join('、')}</div>}
            <div className="hint">不需要外网。存档和账号存在这台电脑上，和线上版分开。</div>
          </div>
        </div>
      ) : (
        <div className="hint">没找到局域网地址：检查这台电脑是不是连上了 WiFi 或网线，连好后刷新页面。</div>
      )}
    </div>
  );
}
