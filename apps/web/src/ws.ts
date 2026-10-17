/** 与服务端的 WebSocket 连接：自动重连、会话 token 持久化。 */
import { useEffect, useRef, useState } from 'react';
import type { GameEvent, PlayerView } from '@shengji/engine';
import type { ClientMessage, RoomInfo, RoomSummary, RoundReplay, ServerMessage } from '@shengji/protocol';
import { checkForUpdate } from './pwa.ts';
import { connectSocket } from './connection.ts';

export interface Toast {
  readonly id: number;
  readonly kind: 'error' | 'info';
  readonly text: string;
}

export interface GameClient {
  readonly connected: boolean;
  readonly name: string;
  readonly room: RoomInfo | null;
  readonly view: PlayerView | null;
  readonly events: readonly GameEvent[];
  readonly toasts: readonly Toast[];
  readonly replay: RoundReplay | null;
  /** 服务器上现有的房间，进入首页后定时刷新 */
  readonly rooms: readonly RoomSummary[] | null;
  send(msg: ClientMessage): void;
  closeReplay(): void;
  setName(name: string): void;
  dismissToast(id: number): void;
}

const NAME_KEY = 'shengji.name';
const TOKEN_KEY = 'shengji.token';
/** 断线时点了退出：本地先离开，重连后补发 leaveRoom */
const PENDING_LEAVE_KEY = 'shengji.pendingLeave';

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function useGameClient(): GameClient {
  const [connected, setConnected] = useState(false);
  const [name, setNameState] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [events, setEvents] = useState<readonly GameEvent[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [replay, setReplay] = useState<RoundReplay | null>(null);
  const [rooms, setRooms] = useState<readonly RoomSummary[] | null>(null);
  const connectionRef = useRef<ReturnType<typeof connectSocket> | null>(null);
  const nameRef = useRef(name);
  const toastId = useRef(0);

  const pushToast = (kind: Toast['kind'], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 3500 : 2500);
  };

  useEffect(() => {
    const connection = connectSocket({
      url: wsUrl,
      onConnected: setConnected,
      onOpen: () => {
        if (nameRef.current) {
          const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
          connection.send(JSON.stringify({ t: 'hello', name: nameRef.current, token }));
          if (localStorage.getItem(PENDING_LEAVE_KEY)) connection.send(JSON.stringify({ t: 'leaveRoom' }));
        } else {
          // Keep the unnamed login screen alive too; ping needs no session.
          connection.send(JSON.stringify({ t: 'ping' }));
        }
      },
      onMessage: (data) => {
        const msg = JSON.parse(data) as ServerMessage;
        switch (msg.t) {
          case 'welcome': localStorage.setItem(TOKEN_KEY, msg.token); void checkForUpdate(); break;
          case 'room':
            if (localStorage.getItem(PENDING_LEAVE_KEY)) {
              // 退出还没被服务端确认前，忽略把我们拉回房间的消息
              if (msg.room) break;
              localStorage.removeItem(PENDING_LEAVE_KEY);
            }
            setRoom(msg.room);
            if (!msg.room || !msg.room.started) setView(null);
            break;
          case 'state':
            if (localStorage.getItem(PENDING_LEAVE_KEY)) break;
            setView(msg.view); setEvents(msg.events); break;
          case 'error': pushToast('error', msg.message); break;
          case 'replay': setReplay(msg.replay); break;
          case 'rooms': setRooms(msg.rooms); break;
          case 'pong': break;
        }
      },
    });
    connectionRef.current = connection;
    return () => { connectionRef.current = null; connection.stop(); };
  }, []);

  const send = (msg: ClientMessage) => {
    if (msg.t === 'leaveRoom') {
      // 退出本地立即生效；断线时记下来，重连后补发
      localStorage.setItem(PENDING_LEAVE_KEY, '1');
      setRoom(null);
      setView(null);
    }
    if (!connectionRef.current?.send(JSON.stringify(msg)) && msg.t !== 'leaveRoom') pushToast('error', '还没连上服务器');
  };

  const setName = (n: string) => {
    const trimmed = n.trim().slice(0, 12);
    nameRef.current = trimmed;
    setNameState(trimmed);
    localStorage.setItem(NAME_KEY, trimmed);
    if (trimmed) {
      const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
      connectionRef.current?.send(JSON.stringify({ t: 'hello', name: trimmed, token }));
    }
  };

  return {
    connected, name, room, view, events, toasts, replay, rooms, send, setName,
    closeReplay: () => setReplay(null),
    dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
  };
}
