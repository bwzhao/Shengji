import { useEffect } from 'react';
import { SUIT_GLYPH } from './components/SuitText.tsx';
import { Home } from './screens/Home.tsx';
import { Lobby } from './screens/Lobby.tsx';
import { Replay } from './screens/Replay.tsx';
import { Table } from './screens/Table.tsx';
import { buildTime } from './pwa.ts';
import { sound } from './sound.ts';
import { useGameClient } from './ws.ts';

export function App() {
  const client = useGameClient();
  useEffect(() => { window.scrollTo(0, 0); }, [client.room?.code, client.room?.started]);

  // 第一次触摸后解锁音频
  useEffect(() => {
    const unlock = () => { sound.unlock(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  useEffect(() => {
    const last = client.toasts[client.toasts.length - 1];
    if (last?.kind === 'error') sound.error();
  }, [client.toasts]);

  let screen;
  if (!client.name || !client.room) screen = <Home client={client} />;
  else if (!client.room.started || !client.view) screen = <Lobby client={client} />;
  else screen = <Table client={client} />;
  return (
    <div className={client.room?.started && client.view ? 'app-shell in-game' : 'app-shell'}>
      <header className="site-header"><div className="brand"><span className="brand-mark" aria-hidden="true">{SUIT_GLYPH.S}</span><div>升级 <span className="brand-slash">/</span> 找朋友</div></div><div className="connection-state"><span className={client.connected ? 'state-dot' : 'state-dot offline-dot'} />{client.connected ? '已连接' : '正在连接'}{client.name && <span className="profile-name">{client.name}</span>}</div></header>
      {screen}
      <footer className="site-footer"><span>升级 · 找朋友</span><span>版本 {buildTime}</span></footer>
      {client.replay && <Replay replay={client.replay} onClose={client.closeReplay} />}
      <div className="toasts" role="status" aria-live="polite">
        {client.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => client.dismissToast(t.id)}>{t.text}</div>
        ))}
      </div>
      {!client.connected && (
        <div className="offline">
          连接断开，正在重连…
          {client.room && <button className="offline-btn" onClick={() => client.send({ t: 'leaveRoom' })}>退出本局</button>}
        </div>
      )}
    </div>
  );
}
