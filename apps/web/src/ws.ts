/** 与服务端的 WebSocket 连接：自动重连、会话 token 持久化。 */
import { useEffect, useRef, useState } from 'react';
import type { DdzEvent, DdzView, GameEvent, PlayerView } from '@shengji/engine';
import type { AccountInfo, AdminAccountRow, ClientMessage, RoomInfo, RoomSummary, RoundReplay, ServerMessage } from '@shengji/protocol';
import { checkForUpdate } from './pwa.ts';
import { connectSocket } from './connection.ts';
import { LATENCY_INTERVAL_MS, LATENCY_SAMPLES, medianLatency } from './latency.ts';

export interface Toast {
  readonly id: number;
  readonly kind: 'error' | 'info';
  readonly text: string;
}

export interface GameClient {
  readonly connected: boolean;
  readonly name: string;
  /** 登录的账号；游客为 null */
  readonly account: AccountInfo | null;
  /** 管理员看到的账号列表，和刚重置出来的临时密码 */
  readonly adminAccounts: readonly AdminAccountRow[] | null;
  readonly tempPassword: { readonly username: string; readonly password: string } | null;
  readonly room: RoomInfo | null;
  readonly view: PlayerView | null;
  readonly events: readonly GameEvent[];
  /** 斗地主房间的牌局和刚发生的事件 */
  readonly ddzView: DdzView | null;
  readonly ddzEvents: readonly DdzEvent[];
  /** 亮主思考时间截止的本地时刻（Date.now() 口径），不在倒计时为 null */
  readonly declareDeadline: number | null;
  /** 四人抄底轮到真人时的截止时刻（本地时间） */
  readonly chaodiDeadline: number | null;
  /** 四人过河还有真人没决定时的截止时刻（本地时间） */
  readonly guoheDeadline: number | null;
  /** 机器人坐庄、埋底前等真人造反的截止时刻（本地时间），和点了「不造反」的座位 */
  readonly zaofanDeadline: number | null;
  readonly zaofanPassed: readonly number[];
  /** 亮主阶段点了「不反」的座位；有人亮主、加固或反主后服务端会清空 */
  readonly declarePassed: readonly number[];
  readonly toasts: readonly Toast[];
  readonly replay: RoundReplay | null;
  /** 服务器上现有的房间，进入首页后定时刷新 */
  readonly rooms: readonly RoomSummary[] | null;
  /** 到服务器一个来回的毫秒数（最近几次的中位数）；没连上或还没量到为 null */
  readonly latency: number | null;
  send(msg: ClientMessage): void;
  closeReplay(): void;
  setName(name: string): void;
  dismissToast(id: number): void;
  clearTempPassword(): void;
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
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [adminAccounts, setAdminAccounts] = useState<readonly AdminAccountRow[] | null>(null);
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [events, setEvents] = useState<readonly GameEvent[]>([]);
  const [ddzView, setDdzView] = useState<DdzView | null>(null);
  const [ddzEvents, setDdzEvents] = useState<readonly DdzEvent[]>([]);
  const [declareDeadline, setDeclareDeadline] = useState<number | null>(null);
  const [declarePassed, setDeclarePassed] = useState<readonly number[]>([]);
  const [chaodiDeadline, setChaodiDeadline] = useState<number | null>(null);
  const [guoheDeadline, setGuoheDeadline] = useState<number | null>(null);
  const [zaofanDeadline, setZaofanDeadline] = useState<number | null>(null);
  const [zaofanPassed, setZaofanPassed] = useState<readonly number[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [replay, setReplay] = useState<RoundReplay | null>(null);
  const [rooms, setRooms] = useState<readonly RoomSummary[] | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const latencySamples = useRef<number[]>([]);
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
      onConnected: (c) => {
        setConnected(c);
        // 断线重连后重新量
        if (!c) { latencySamples.current = []; setLatency(null); }
      },
      onOpen: () => {
        if (nameRef.current) {
          const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
          connection.send(JSON.stringify({ t: 'hello', name: nameRef.current, token }));
          if (localStorage.getItem(PENDING_LEAVE_KEY)) connection.send(JSON.stringify({ t: 'leaveRoom' }));
        }
        // 连上就先量一次延迟；还没填名字时也靠它让服务端回话，ping 不需要会话
        ping();
      },
      onMessage: (data) => {
        const msg = JSON.parse(data) as ServerMessage;
        switch (msg.t) {
          case 'welcome':
            localStorage.setItem(TOKEN_KEY, msg.token);
            setAccount(msg.account);
            // 登录后名字就是账号的显示名字
            rememberName(msg.name);
            void checkForUpdate();
            break;
          case 'account': setAccount(msg.account); rememberName(msg.account.displayName); break;
          case 'loggedOut':
            // 这台设备回到首页，重新填名字当游客；账号的座位留着
            localStorage.removeItem(TOKEN_KEY);
            setAccount(null); setAdminAccounts(null); rememberName('');
            setRoom(null); setView(null); setDdzView(null);
            pushToast('info', '已退出登录');
            break;
          case 'notice': pushToast('info', msg.message); break;
          case 'adminAccounts': setAdminAccounts(msg.accounts); break;
          case 'adminTempPassword': setTempPassword({ username: msg.username, password: msg.password }); break;
          case 'room':
            if (localStorage.getItem(PENDING_LEAVE_KEY)) {
              // 退出还没被服务端确认前，忽略把我们拉回房间的消息
              if (msg.room) break;
              localStorage.removeItem(PENDING_LEAVE_KEY);
            }
            setRoom(msg.room);
            if (!msg.room || !msg.room.started) { setView(null); setDdzView(null); }
            break;
          case 'state':
            if (localStorage.getItem(PENDING_LEAVE_KEY)) break;
            setView(msg.view); setEvents(msg.events);
            setDeclareDeadline(msg.declareLeftMs === undefined ? null : Date.now() + msg.declareLeftMs);
            setDeclarePassed(msg.declarePassed ?? []);
            setChaodiDeadline(msg.chaodiLeftMs === undefined ? null : Date.now() + msg.chaodiLeftMs);
            setGuoheDeadline(msg.guoheLeftMs === undefined ? null : Date.now() + msg.guoheLeftMs);
            setZaofanDeadline(msg.zaofanLeftMs === undefined ? null : Date.now() + msg.zaofanLeftMs);
            setZaofanPassed(msg.zaofanPassed ?? []);
            break;
          case 'ddzState':
            if (localStorage.getItem(PENDING_LEAVE_KEY)) break;
            setDdzView(msg.view); setDdzEvents(msg.events);
            break;
          case 'error':
            // 游客用了已注册账号的显示名字：清掉名字，回首页重新填
            if (msg.code === 'NAME_TAKEN') rememberName('');
            pushToast('error', msg.message);
            break;
          case 'replay': setReplay(msg.replay); break;
          case 'rooms': setRooms(msg.rooms); break;
          case 'pong':
            if (msg.at !== undefined) {
              latencySamples.current = [...latencySamples.current, performance.now() - msg.at].slice(-LATENCY_SAMPLES);
              setLatency(medianLatency(latencySamples.current));
            }
            break;
        }
      },
    });
    connectionRef.current = connection;
    // 量延迟：页面在前台时每隔几秒发一个带时间的 ping，服务端原样带回时间
    function ping() {
      connection.send(JSON.stringify({ t: 'ping', at: performance.now() }));
    }
    const pinger = setInterval(() => { if (document.visibilityState === 'visible') ping(); }, LATENCY_INTERVAL_MS);
    return () => { clearInterval(pinger); connectionRef.current = null; connection.stop(); };
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

  /** 记下服务端认定的名字（不再发 hello） */
  function rememberName(n: string): void {
    nameRef.current = n;
    setNameState(n);
    if (n) localStorage.setItem(NAME_KEY, n); else localStorage.removeItem(NAME_KEY);
  }

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
    connected, name, account, adminAccounts, tempPassword, room, view, events, ddzView, ddzEvents, declareDeadline, declarePassed, chaodiDeadline, guoheDeadline, zaofanDeadline, zaofanPassed, toasts, replay, rooms, latency, send, setName,
    closeReplay: () => setReplay(null),
    clearTempPassword: () => setTempPassword(null),
    dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
  };
}
