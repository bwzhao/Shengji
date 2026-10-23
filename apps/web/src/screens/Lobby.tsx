import type { GameClient } from '../ws.ts';
import { Avatar } from '../avatar.tsx';

export function Lobby({ client }: { client: GameClient }) {
  const room = client.room!;
  const full = room.seats.every((s) => s);
  const shareUrl = `${location.origin}/?room=${room.code}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(`来打${room.game === 'doudizhu' ? '斗地主' : '找朋友'}：${shareUrl} 房间码 ${room.code}`); } catch { /* 忽略 */ }
  };
  return (
    <div className="page-bg">
      <div className="lobby">
        <div className="code-card">
          <div className="label">房间码</div>
          <div className="big-code">{room.code}</div>
          <div className="hint">{room.game === 'doudizhu' ? '三人斗地主' : `${room.players} 人局`} · 按座位号逆时针出牌 · 把房间码发给朋友</div>
          <button className="ghost" onClick={copy}>复制邀请</button>
        </div>
        <div className="seats">
          {room.seats.map((s, i) => (
            <div key={i} className={`seat ${s ? 'taken' : 'empty'} ${room.you === i ? 'mine' : ''}`}>
              <div className="seat-no">{i + 1} 号位</div>
              {s ? (
                <>
                  <div className="seat-name"><Avatar name={s.name} isBot={s.isBot} size={44} />{s.name}{s.isHost && <span className="tag">房主</span>}{s.isBot && <span className="tag">机器人</span>}{s.guest && <span className="tag">游客</span>}</div>
                  {!s.connected && <div className="seat-off">已断线</div>}
                  {room.youAreHost && s.isBot && <button className="ghost small" onClick={() => client.send({ t: 'removeBot', seat: i })}>移除</button>}
                  {room.you === i && <button className="ghost small" onClick={() => client.send({ t: 'stand' })}>起立</button>}
                </>
              ) : (
                <div className="seat-actions">
                  <button className="ghost small" onClick={() => client.send({ t: 'sit', seat: i })}>坐下</button>
                  {room.youAreHost && <button className="ghost small" onClick={() => client.send({ t: 'addBot', seat: i })}>加机器人</button>}
                </div>
              )}
            </div>
          ))}
        </div>
        {room.game !== 'doudizhu' && (
          <div className="lobby-settings">
            <div className="panel bots-panel">
              <div className="panel-title">机器人</div>
              <div className="seg">
                <button className={room.botStrength === 'normal' ? 'on' : ''} disabled={!room.youAreHost} onClick={() => client.send({ t: 'setBots', strength: 'normal' })}>普通 · 反应快</button>
                <button className={room.botStrength === 'strong' ? 'on' : ''} disabled={!room.youAreHost} onClick={() => client.send({ t: 'setBots', strength: 'strong' })}>加强 · 会算牌</button>
              </div>
              <div className="hint">{room.botStrength === 'strong' ? '加强版每手会推演几十种可能的牌局再出牌，多等约一秒。' : '普通版按牌桌常识出牌，几乎不用等。'}{!room.youAreHost && ' 只有房主能改。'} 机器人以电影明星命名，头像取自维基百科的自由授权照片。</div>
            </div>
            <div className="panel bots-panel">
              <div className="panel-title">出牌记录</div>
              <div className="seg">
                <button className={room.playLogOpen ? '' : 'on'} disabled={!room.youAreHost} onClick={() => client.send({ t: 'setPlayLog', open: false })}>只看自己的</button>
                <button className={room.playLogOpen ? 'on' : ''} disabled={!room.youAreHost} onClick={() => client.send({ t: 'setPlayLog', open: true })}>可看所有人的</button>
              </div>
              <div className="hint">{room.playLogOpen ? '牌局中可以翻看每一墩所有人出的牌。' : '牌局中只能翻看自己出过的牌，别人出的要靠记；「上一轮」照常能看。'}{!room.youAreHost && ' 只有房主能改。'}</div>
            </div>
          </div>
        )}
        <div className="lobby-actions">
          {room.youAreHost ? (
            <button className="primary" disabled={!full} onClick={() => client.send({ t: 'start' })}>
              {full ? '开始游戏' : `还差 ${room.seats.filter((s) => !s).length} 人`}
            </button>
          ) : (
            <div className="hint">等待房主开始</div>
          )}
          <button className="ghost" onClick={() => client.send({ t: 'leaveRoom' })}>离开房间</button>
          {room.youAreHost && (
            <button className="ghost danger" onClick={() => { if (confirm(`关闭房间 ${room.code}？所有人都会回到首页。`)) client.send({ t: 'closeRoom' }); }}>关闭房间</button>
          )}
        </div>
      </div>
    </div>
  );
}
