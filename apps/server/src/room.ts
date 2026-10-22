/** 一个房间：大厅座位管理 + 驾驭引擎状态机 + 机器人 + 广播。 */
import {
  applyAction, createGame, createRng, currentTurn, defaultConfig, waitingSeats, LEVEL_SEQUENCE, restartRound, smartAction, smartDeclare, tuneForMode, viewFor,
  type Action, type GameConfig, type GameEvent, type GameState, type PlayerView, type Rng, type Seat,
} from '@shengji/engine';
import type { RoomInfo, RoomSummary, RoundReplay, ServerMessage } from '@shengji/protocol';
import type { WebSocket } from 'ws';
import type { RoomSnapshot } from './store.ts';
import { getSearchPool } from './searchPool.ts';
import { pickStarName } from './stars.ts';

export interface Member {
  readonly token: string;
  name: string;
  socket: WebSocket | null;
}

interface SeatSlot {
  readonly token: string;
  readonly isBot: boolean;
  /** 机器人的明星名字 */
  readonly name?: string;
}

export interface RoomOptions {
  readonly dealIntervalMs: number;
  /** 抢庄时的发牌间隔：首局从头到尾，非首局重新抢庄到有人亮主定了庄家为止。不设就和平时一样 */
  readonly grabDealIntervalMs?: number;
  /** 发完牌后的亮主思考时间；有人亮主、加固或反主就重新计时 */
  readonly declareGraceMs: number;
  /** 四人抄底：轮到的真人想多久，到时当作不抄。不设是 30 秒 */
  readonly chaodiGraceMs?: number;
  /** 四人过河：问能过河的人时大家共用的思考时间，到时没决定的当作不过。不设是 60 秒 */
  readonly guoheGraceMs?: number;
  /** 造反：机器人坐庄时等这么久再埋底，给真人时间造反；真人都点了「不造反」就不等。不设是 10 秒 */
  readonly zaofanWaitMs?: number;
  readonly botDelayMs: number;
  /** 搜索机器人每手的时间预算 */
  readonly searchBudgetMs: number;
}

export const defaultRoomOptions: RoomOptions = { dealIntervalMs: 150, grabDealIntervalMs: 200, declareGraceMs: 30_000, botDelayMs: 900, searchBudgetMs: 1100 };

export class Room {
  readonly code: string;
  readonly config: GameConfig;
  readonly members = new Map<string, Member>();
  readonly seats: (SeatSlot | null)[];
  hostToken: string;
  state: GameState | null = null;
  seq = 0;
  lastActivity = Date.now();
  /** 最近几局的操作日志，用于回放 */
  roundLogs: RoundReplay[] = [];
  botStrength: 'normal' | 'strong' = 'strong';
  /** 出牌记录能不能看别人出的牌；默认锁住，只看自己的，房主可以打开 */
  playLogOpen = false;
  /** 正在进行的异步搜索的序号，用来丢弃过期结果 */
  private searchEpoch = 0;
  private readonly rng: Rng;
  private dealTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  /** 亮主思考时间的截止时刻；不在 declaring 阶段、或因为没有真人在线暂停时为 null */
  private declareDeadline: number | null = null;
  /** declaring 阶段机器人考虑反主 */
  private declareBotTimer: NodeJS.Timeout | null = null;
  /** 点了「不反」的座位；有人亮主、加固或反主就清空，大家重新决定 */
  private readonly declarePassed = new Set<Seat>();
  /** 抄底：现在被问的座位、他决定的截止时刻（只给真人计时）和计时器 */
  private chaodiAsked: Seat | null = null;
  private chaodiDeadline: number | null = null;
  private chaodiTimer: NodeJS.Timeout | null = null;
  /** 过河：截止时刻和计时器；只在还有真人没决定过不过河时计时，给牌还牌不计时 */
  private guoheDeadline: number | null = null;
  private guoheTimer: NodeJS.Timeout | null = null;
  /** 造反：机器人庄家埋底前等到的时刻，和点了「不造反」的座位 */
  private zaofanDeadline: number | null = null;
  private readonly zaofanPassed = new Set<Seat>();
  private botTimer: NodeJS.Timeout | null = null;
  /** 真人只剩唯一合法出法时自动代出 */
  private autoTimer: NodeJS.Timeout | null = null;
  private readonly opts: RoomOptions;
  /** 任何需要落盘的变化后调用 */
  onChange: () => void = () => {};

  constructor(code: string, players: 4 | 5 | 6, hostToken: string, opts: RoomOptions = defaultRoomOptions) {
    this.code = code;
    this.config = defaultConfig(players);
    this.hostToken = hostToken;
    this.seats = Array.from({ length: players }, () => null);
    this.rng = createRng(`bots/${code}/${Date.now()}`);
    this.opts = opts;
  }

  toSnapshot(): RoomSnapshot {
    return {
      code: this.code,
      players: this.config.players,
      hostToken: this.hostToken,
      seats: this.seats.map((s) => (s ? { token: s.token, isBot: s.isBot, name: s.name } : null)),
      members: [...this.members.values()].map((m) => ({ token: m.token, name: m.name })),
      state: this.state,
      seq: this.seq,
      lastActivity: this.lastActivity,
      roundLogs: this.roundLogs,
      botStrength: this.botStrength,
      playLogOpen: this.playLogOpen,
    };
  }

  static fromSnapshot(snap: RoomSnapshot, opts: RoomOptions): Room {
    const room = new Room(snap.code, snap.players, snap.hostToken, opts);
    snap.seats.forEach((s, i) => { room.seats[i] = s ? { token: s.token, isBot: s.isBot, name: s.name } : null; });
    for (const m of snap.members) room.members.set(m.token, { token: m.token, name: m.name, socket: null });
    room.state = snap.state ? migrateDealerRule(migrateLadder(snap.state)) : snap.state;
    room.seq = snap.seq;
    room.lastActivity = snap.lastActivity;
    room.roundLogs = [...(snap.roundLogs ?? [])];
    room.botStrength = snap.botStrength ?? 'strong';
    room.playLogOpen = snap.playLogOpen ?? false;
    return room;
  }

  /** 恢复后重新挂上定时器（发牌、亮主缓冲、机器人） */
  resume(): void {
    if (this.state) this.afterChange([]);
  }

  get started(): boolean {
    return this.state !== null;
  }

  /** 新建一个机器人座位，名字从明星表里挑一个本房间没用过的 */
  private makeBot(seat: Seat): SeatSlot {
    const used = new Set<string>();
    for (const s of this.seats) if (s?.isBot && s.name) used.add(s.name);
    return { token: `bot:${seat}`, isBot: true, name: pickStarName(used, () => this.rng.next(), `机器人${seat + 1}`) };
  }

  /** 有没有真人在线：没有的话机器人暂停，不再空转 */
  humansOnline(): boolean {
    return this.onlineHumanSeats().length > 0;
  }

  private onlineHumanSeats(): Seat[] {
    const seats: Seat[] = [];
    for (const [i, slot] of this.seats.entries()) {
      if (!slot || slot.isBot) continue;
      const m = this.members.get(slot.token);
      if (m?.socket && m.socket.readyState === m.socket.OPEN) seats.push(i);
    }
    return seats;
  }

  seatOf(token: string): Seat | null {
    const i = this.seats.findIndex((s) => s?.token === token);
    return i >= 0 ? i : null;
  }

  private send(m: Member | undefined, msg: ServerMessage): void {
    if (m?.socket && m.socket.readyState === m.socket.OPEN) m.socket.send(JSON.stringify(msg));
  }

  private error(token: string, code: string, message: string): void {
    this.send(this.members.get(token), { t: 'error', code, message });
  }

  info(forToken: string): RoomInfo {
    return {
      code: this.code,
      players: this.config.players,
      seats: this.seats.map((s, seat) => {
        if (!s) return null;
        const m = this.members.get(s.token);
        return {
          seat,
          name: s.isBot ? (s.name ?? `机器人${seat + 1}`) : (m?.name ?? '?'),
          connected: s.isBot || Boolean(m?.socket && m.socket.readyState === m.socket.OPEN),
          isBot: s.isBot,
          isHost: s.token === this.hostToken,
        };
      }),
      started: this.started,
      botStrength: this.botStrength,
      playLogOpen: this.playLogOpen,
      you: this.seatOf(forToken),
      youAreHost: forToken === this.hostToken,
    };
  }

  setBots(token: string, strength: 'normal' | 'strong'): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能设置机器人');
    this.botStrength = strength;
    this.broadcastRoom();
  }

  setPlayLog(token: string, open: boolean): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能设置出牌记录');
    this.playLogOpen = open;
    this.broadcastRoom();
    // 开局后改的话，大家手里的出牌记录跟着变
    this.broadcastState([]);
    this.onChange();
  }

  /** 只有房主能关；没人在线的房间空闲两小时后由 registry.gc 回收，不用别人代关 */
  canClose(token: string): boolean {
    return token === this.hostToken;
  }

  /** 关闭房间：通知所有成员回首页，清掉定时器 */
  close(reason: string): void {
    this.dispose();
    for (const m of this.members.values()) {
      this.send(m, { t: 'error', code: 'ROOM_CLOSED', message: reason });
      this.send(m, { t: 'room', room: null });
    }
    this.members.clear();
    this.state = null;
  }

  summary(forToken: string): RoomSummary {
    let humans = 0, online = 0, bots = 0;
    const names: string[] = [];
    for (const [i, slot] of this.seats.entries()) {
      if (!slot) continue;
      if (slot.isBot) { bots++; continue; }
      humans++;
      const m = this.members.get(slot.token);
      if (m?.socket && m.socket.readyState === m.socket.OPEN) online++;
      names.push(this.nameOfSeat(i, slot));
    }
    const hostSeat = this.seatOf(this.hostToken);
    return {
      code: this.code,
      players: this.config.players,
      started: this.started,
      round: this.state?.round ?? 0,
      phase: this.state?.phase ?? null,
      humans,
      humansOnline: online,
      bots,
      names,
      hostName: hostSeat !== null ? this.nameOfSeat(hostSeat, this.seats[hostSeat] ?? null) : (this.members.get(this.hostToken)?.name ?? '?'),
      joinable: this.seats.some((s) => !s || s.isBot),
      canClose: this.canClose(forToken),
      lastActivity: this.lastActivity,
    };
  }

  broadcastRoom(): void {
    for (const m of this.members.values()) this.send(m, { t: 'room', room: this.info(m.token) });
    this.onChange();
  }

  /** 发给某个座位的视图；出牌记录没开放时每一墩只留他自己出的牌（上一墩 lastTrick 照常完整，供「上一轮」） */
  private viewOf(seat: Seat): PlayerView {
    const view = viewFor(this.state as GameState, seat);
    if (this.playLogOpen) return view;
    return { ...view, tricks: view.tricks.map((t) => ({ ...t, plays: t.plays.filter((p) => p.seat === seat) })) };
  }

  private broadcastState(events: readonly GameEvent[]): void {
    if (!this.state) return;
    this.seq++;
    for (const [seat, slot] of this.seats.entries()) {
      if (!slot || slot.isBot) continue;
      const m = this.members.get(slot.token);
      if (!m) continue;
      const filtered = events.map((e) => (e.type === 'cardDealt' && e.seat !== seat ? { ...e, card: hiddenCard } : e));
      this.send(m, { t: 'state', seq: this.seq, view: this.viewOf(seat), events: filtered, ...this.declareTimer(), ...this.chaodiTimerInfo(), ...this.guoheTimerInfo(), ...this.zaofanInfo() });
    }
  }

  /** 亮主还剩多少毫秒、谁点了不反，随 state 消息下发；发剩余时间而不是截止时刻，客户端时钟不准也没关系 */
  private declareTimer(): { declareLeftMs?: number; declarePassed?: Seat[] } {
    if (this.state?.phase !== 'declaring' || this.declareDeadline === null) return {};
    return { declareLeftMs: Math.max(0, this.declareDeadline - Date.now()), declarePassed: [...this.declarePassed].sort((a, b) => a - b) };
  }

  /** 抄底还剩多少毫秒（轮到真人时才有） */
  private chaodiTimerInfo(): { chaodiLeftMs?: number } {
    if (this.state?.phase !== 'chaodi' || this.chaodiDeadline === null) return {};
    return { chaodiLeftMs: Math.max(0, this.chaodiDeadline - Date.now()) };
  }

  /** 过河还剩多少毫秒（还有真人没决定过不过河时才有） */
  private guoheTimerInfo(): { guoheLeftMs?: number } {
    if (this.state?.phase !== 'guohe' || this.guoheDeadline === null) return {};
    return { guoheLeftMs: Math.max(0, this.guoheDeadline - Date.now()) };
  }

  /** 机器人庄家第一次埋底前等真人造反：还剩多少毫秒、谁点了「不造反」 */
  private zaofanInfo(): { zaofanLeftMs?: number; zaofanPassed?: Seat[] } {
    if (!this.botDealerWaiting() || this.zaofanDeadline === null) return {};
    return { zaofanLeftMs: Math.max(0, this.zaofanDeadline - Date.now()), zaofanPassed: [...this.zaofanPassed].sort((a, b) => a - b) };
  }

  /** 机器人坐庄、第一次埋底（四人抄底开始前）：这段时间真人可以造反，机器人先等着 */
  private botDealerWaiting(): boolean {
    const s = this.state;
    if (!s || s.phase !== 'bottom' || !s.config.zaofan || s.dealer === null) return false;
    if ((s.declarationLog ?? []).some((e) => e.kind === 'chaodi')) return false;
    return Boolean(this.seats[s.dealer]?.isBot);
  }

  /** 机器人庄家埋底前还要等多久；除庄家外在线的真人都点了「不造反」就不等 */
  private zaofanHoldMs(): number {
    if (!this.botDealerWaiting()) return 0;
    const dealer = this.state?.dealer;
    if (this.onlineHumanSeats().every((s) => s === dealer || this.zaofanPassed.has(s))) return 0;
    this.zaofanDeadline ??= Date.now() + (this.opts.zaofanWaitMs ?? 10_000);
    return Math.max(0, this.zaofanDeadline - Date.now());
  }

  /** 离开机器人庄家埋底就清掉造反等待；进入时开始计时 */
  private updateZaofanWindow(): void {
    if (!this.botDealerWaiting()) {
      this.zaofanPassed.clear();
      this.zaofanDeadline = null;
      return;
    }
    if (this.humansOnline()) this.zaofanDeadline ??= Date.now() + (this.opts.zaofanWaitMs ?? 10_000);
  }

  /** 「不造反」：除庄家外在线的真人都点了，机器人庄家就不再等，马上埋底 */
  passZaofan(token: string): void {
    const seat = this.seatOf(token);
    if (seat === null || !this.botDealerWaiting()) return this.error(token, 'WRONG_PHASE', '现在不用决定造不造反');
    this.zaofanPassed.add(seat);
    this.lastActivity = Date.now();
    if (this.zaofanHoldMs() === 0 && this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
      this.scheduleBot();
    }
    this.broadcastState([]);
  }

  /** 重连或首次连接时补发当前状态 */
  sync(token: string): void {
    const m = this.members.get(token);
    this.send(m, { t: 'room', room: this.info(token) });
    const seat = this.seatOf(token);
    if (this.state && seat !== null) {
      this.send(m, { t: 'state', seq: this.seq, view: this.viewOf(seat), events: [], ...this.declareTimer(), ...this.chaodiTimerInfo(), ...this.guoheTimerInfo(), ...this.zaofanInfo() });
    }
  }

  // ---------- 大厅 ----------

  join(token: string, name: string, socket: WebSocket | null): void {
    const existing = this.members.get(token);
    if (existing) {
      existing.socket = socket;
      existing.name = name;
    } else {
      this.members.set(token, { token, name, socket });
    }
    this.lastActivity = Date.now();
    // 真人回来了：如果牌局因为没人在线而暂停，重新挂上定时器（不广播，状态由 sync 补发）
    if (socket && this.state && this.seatOf(token) !== null) this.armTimers();
  }

  detach(token: string, socket: WebSocket): void {
    const m = this.members.get(token);
    // A previous connection may close after hello has already attached its replacement.
    if (!m || m.socket !== socket) return;
    m.socket = null;
    if (!this.started && this.seatOf(token) !== null) {
      // 游戏未开始时掉线直接让座
      const seat = this.seatOf(token) as Seat;
      this.seats[seat] = null;
    }
    this.broadcastRoom();
  }

  leave(token: string): void {
    const seat = this.seatOf(token);
    if (this.started && seat !== null) {
      // 游戏中离开：座位交给机器人接管；房主离开则把房主交给下一位真人
      this.seats[seat] = this.makeBot(seat);
      this.members.delete(token);
      if (token === this.hostToken) {
        const next = this.seats.find((s) => s && !s.isBot);
        if (next) this.hostToken = next.token;
      }
      this.broadcastRoom();
      this.afterChange([]);
      return;
    }
    if (seat !== null) this.seats[seat] = null;
    this.members.delete(token);
    if (token === this.hostToken) {
      const next = this.seats.find((s) => s && !s.isBot);
      if (next) this.hostToken = next.token;
      else {
        const first = this.members.keys().next();
        if (!first.done) this.hostToken = first.value;
      }
    }
    this.broadcastRoom();
  }

  /** 开局后进来的人接管一个机器人座位；没有机器人座位返回 false */
  takeoverBot(token: string): boolean {
    const i = this.seats.findIndex((s) => s?.isBot);
    if (i < 0) return false;
    this.seats[i] = { token, isBot: false };
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    this.broadcastRoom();
    this.afterChange([]);
    return true;
  }

  sit(token: string, seat: Seat): void {
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    if (seat < 0 || seat >= this.seats.length) return this.error(token, 'BAD_SEAT', '座位不存在');
    if (this.seats[seat]) return this.error(token, 'SEAT_TAKEN', '这个座位已经有人');
    const cur = this.seatOf(token);
    if (cur !== null) this.seats[cur] = null;
    this.seats[seat] = { token, isBot: false };
    this.broadcastRoom();
  }

  stand(token: string): void {
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    const cur = this.seatOf(token);
    if (cur !== null) this.seats[cur] = null;
    this.broadcastRoom();
  }

  addBot(token: string, seat: Seat): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能添加机器人');
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    if (this.seats[seat]) return this.error(token, 'SEAT_TAKEN', '这个座位已经有人');
    this.seats[seat] = this.makeBot(seat);
    this.broadcastRoom();
  }

  removeBot(token: string, seat: Seat): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能移除机器人');
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    if (!this.seats[seat]?.isBot) return this.error(token, 'NOT_BOT', '这个座位不是机器人');
    this.seats[seat] = null;
    this.broadcastRoom();
  }

  start(token: string): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能开始');
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    if (this.seats.some((s) => !s)) return this.error(token, 'NOT_FULL', '人还没坐满');
    const hostSeat = this.seatOf(token) ?? 0;
    this.state = createGame(this.config, `${this.code}/${Date.now()}`, { firstDealSeat: hostSeat });
    this.beginRoundLog(this.state);
    this.broadcastRoom();
    this.afterChange([]);
  }

  // ---------- 游戏 ----------

  act(token: string, action: Action): void {
    if (!this.state) return this.error(token, 'NOT_STARTED', '游戏还没开始');
    if (action.type === 'nextRound' && token !== this.hostToken) {
      return this.error(token, 'NOT_HOST', '由房主开始下一局');
    }
    const r = applyAction(this.state, action);
    if (!r.ok) return this.error(token, r.error.code, r.error.message);
    this.record(action, r.state, r.events);
    this.state = r.state;
    this.lastActivity = Date.now();
    this.afterChange(r.events);
  }

  /** 房主重发本局 */
  restartRound(token: string): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能重发本局');
    if (!this.state) return this.error(token, 'NOT_STARTED', '游戏还没开始');
    if (this.state.phase === 'gameOver') return this.error(token, 'WRONG_PHASE', '游戏已经结束，请回大厅重新开始');
    this.dispose();
    const r = restartRound(this.state);
    this.state = r.state;
    this.beginRoundLog(r.state);
    this.lastActivity = Date.now();
    this.afterChange(r.events);
  }

  /** 房主结束游戏：回到大厅，座位与机器人保留，等级从头开始 */
  abortGame(token: string): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能结束游戏');
    if (!this.state) return this.error(token, 'NOT_STARTED', '游戏还没开始');
    this.dispose();
    this.state = null;
    this.seq++;
    this.lastActivity = Date.now();
    this.broadcastRoom();
  }

  private beginRoundLog(initial: GameState): void {
    this.roundLogs.push({ round: initial.round, initial, actions: [], names: this.seats.map((s, i) => this.nameOfSeat(i, s)) });
    if (this.roundLogs.length > 6) this.roundLogs.shift();
  }

  private nameOfSeat(seat: Seat, slot: SeatSlot | null): string {
    if (!slot) return `${seat + 1} 号`;
    if (slot.isBot) return slot.name ?? `机器人${seat + 1}`;
    return this.members.get(slot.token)?.name ?? `${seat + 1} 号`;
  }

  /** 记录一次成功的操作；进入新一局或重发时另起一份日志 */
  private record(action: Action, next: GameState, events: readonly GameEvent[]): void {
    const cur = this.roundLogs[this.roundLogs.length - 1];
    if (cur) (cur.actions as Action[]).push(action);
    if (events.some((e) => e.type === 'dealerChanged' || e.type === 'redeal' || e.type === 'regrab' || e.type === 'zaofan')) this.beginRoundLog(next);
  }

  replayFor(token: string, round: number): void {
    const log = this.roundLogs.find((r) => r.round === round);
    const finished = this.state && (this.state.round > round || this.state.phase === 'roundEnd' || this.state.phase === 'gameOver');
    if (!log || !finished) return this.error(token, 'NO_REPLAY', '这一局还没结束或者已经太久');
    this.send(this.members.get(token), { t: 'replay', replay: log });
  }

  private apply(action: Action): boolean {
    if (!this.state) return false;
    const r = applyAction(this.state, action);
    if (!r.ok) {
      console.error(`[${this.code}] 内部操作失败 ${action.type}: ${r.error.code} ${r.error.message}`);
      return false;
    }
    this.record(action, r.state, r.events);
    this.state = r.state;
    this.afterChange(r.events);
    return true;
  }

  private afterChange(events: readonly GameEvent[]): void {
    this.searchEpoch++;
    this.updateDeclareWindow(events);
    this.updateChaodiWindow();
    this.updateGuoheWindow();
    this.updateZaofanWindow();
    this.broadcastState(events);
    this.onChange();
    this.armTimers();
  }

  /** 抄底轮到新的人就重新计时：真人 30 秒，机器人不计时（它很快就答） */
  private updateChaodiWindow(): void {
    const s = this.state;
    const asked = s?.phase === 'chaodi' ? currentTurn(s) : null;
    if (asked === this.chaodiAsked) return;
    this.clearChaodiTimer();
    this.chaodiAsked = asked;
    this.chaodiDeadline = asked !== null && !this.seats[asked]?.isBot ? Date.now() + (this.opts.chaodiGraceMs ?? 30_000) : null;
  }

  /** 过河：大家共用一个倒计时，进入过河时开始；真人都决定了（只剩给牌还牌）或离开过河阶段就停 */
  private updateGuoheWindow(): void {
    const s = this.state;
    const humanAsked = s?.phase === 'guohe' && (s.guohe?.asked ?? []).some((seat) => !this.seats[seat]?.isBot);
    if (humanAsked) {
      this.guoheDeadline ??= Date.now() + (this.opts.guoheGraceMs ?? 60_000);
      return;
    }
    if (this.guoheTimer) { clearTimeout(this.guoheTimer); this.guoheTimer = null; }
    this.guoheDeadline = null;
  }

  private guoheTimeUp(): void {
    this.guoheTimer = null;
    const s = this.state;
    if (!s || s.phase !== 'guohe') return;
    // 没有真人在线就暂停，真人回来后重新计时
    if (!this.humansOnline()) { this.guoheDeadline = null; return; }
    for (const seat of [...(s.guohe?.asked ?? [])]) {
      if (this.state?.phase !== 'guohe' || !this.state.guohe?.asked.includes(seat)) continue;
      this.apply({ type: 'passGuohe', seat });
    }
  }

  private clearChaodiTimer(): void {
    if (this.chaodiTimer) { clearTimeout(this.chaodiTimer); this.chaodiTimer = null; }
  }

  private chaodiTimeUp(): void {
    this.chaodiTimer = null;
    const s = this.state;
    const asked = this.chaodiAsked;
    if (!s || s.phase !== 'chaodi' || asked === null || currentTurn(s) !== asked) return;
    // 没有真人在线就暂停，真人回来后重新计时
    if (!this.humansOnline()) { this.chaodiDeadline = null; return; }
    this.apply({ type: 'passChaodi', seat: asked });
  }

  /** 刚发完牌或有人亮主、加固、反主时重新计时，「不反」也作废；离开 declaring 阶段就清掉 */
  private updateDeclareWindow(events: readonly GameEvent[]): void {
    if (this.state?.phase !== 'declaring') {
      this.declareDeadline = null;
      this.declarePassed.clear();
      this.clearTimer('grace');
      return;
    }
    if (this.declareDeadline !== null && !events.some((e) => e.type === 'declared')) return;
    this.clearTimer('grace');
    this.declareDeadline = Date.now() + this.opts.declareGraceMs;
    this.declarePassed.clear();
  }

  /** 真人点「不反」：在线的真人都点了就不再等倒计时 */
  passDeclare(token: string): void {
    const seat = this.seatOf(token);
    if (seat === null || this.state?.phase !== 'declaring') return this.error(token, 'WRONG_PHASE', '现在不是亮主阶段');
    this.declarePassed.add(seat);
    this.lastActivity = Date.now();
    if (this.onlineHumanSeats().every((s) => this.declarePassed.has(s))) return this.closeDeclaringNow();
    this.broadcastState([]);
  }

  /** 按当前阶段挂上需要的定时器：发牌、亮主思考时间、机器人出牌、自动下一局 */
  private armTimers(): void {
    const s = this.state;
    if (!s) return;
    switch (s.phase) {
      case 'dealing':
        this.clearTimer('grace');
        if (!this.dealTimer) this.dealTimer = setTimeout(() => this.dealTick(), this.dealInterval(s));
        break;
      case 'declaring':
        this.clearTimer('deal');
        // 暂停后真人回来：重新给满思考时间
        this.declareDeadline ??= Date.now() + this.opts.declareGraceMs;
        if (!this.graceTimer) this.graceTimer = setTimeout(() => this.declareTimeUp(), Math.max(0, this.declareDeadline - Date.now()));
        // 机器人在计时开始或有人亮主后稍等一下就考虑反主，不等到倒计时结束
        if (!this.declareBotTimer && this.humansOnline()) {
          this.declareBotTimer = setTimeout(() => {
            this.declareBotTimer = null;
            this.botsDeclareNow();
          }, this.opts.botDelayMs);
        }
        break;
      case 'chaodi':
        this.scheduleBot();
        // 轮到真人：30 秒不决定就当不抄（暂停后回来、或真人刚接管机器人座位时补上计时）
        if (this.chaodiAsked !== null && !this.seats[this.chaodiAsked]?.isBot) {
          this.chaodiDeadline ??= Date.now() + (this.opts.chaodiGraceMs ?? 30_000);
          if (!this.chaodiTimer) this.chaodiTimer = setTimeout(() => this.chaodiTimeUp(), Math.max(0, this.chaodiDeadline - Date.now()));
        }
        break;
      case 'guohe':
        this.scheduleBot();
        // 还有真人没决定：大家共用 60 秒，到时当作不过（暂停后回来重新给满）
        if ((s.guohe?.asked ?? []).some((seat) => !this.seats[seat]?.isBot)) {
          this.guoheDeadline ??= Date.now() + (this.opts.guoheGraceMs ?? 60_000);
          if (!this.guoheTimer) this.guoheTimer = setTimeout(() => this.guoheTimeUp(), Math.max(0, this.guoheDeadline - Date.now()));
        }
        break;
      case 'bottom':
      case 'callFriend':
      case 'playing':
        this.scheduleBot();
        this.scheduleAutoPlay();
        break;
      case 'roundEnd':
        // 房主不在座位上时自动开下一局，但没有真人在线就先停着
        if (!this.botTimer && this.humansOnline() && this.seatOf(this.hostToken) === null) {
          this.botTimer = setTimeout(() => {
            this.botTimer = null;
            if (this.humansOnline()) this.apply({ type: 'nextRound' });
          }, 8000);
        }
        break;
      case 'gameOver':
        break;
    }
  }

  private declareTimeUp(): void {
    this.graceTimer = null;
    if (!this.state || this.state.phase !== 'declaring') return;
    // 没有真人在线就暂停，真人回来后重新计时
    if (!this.humansOnline()) { this.declareDeadline = null; return; }
    this.closeDeclaringNow();
  }

  /** 倒计时到点或真人都不反：先让机器人最后看一眼，机器人反了主就重新计时，给真人时间再反 */
  private closeDeclaringNow(): void {
    if (this.botsDeclareNow()) return;
    this.apply({ type: 'closeDeclaring' });
  }

  /** declaring 阶段机器人亮主或反主，走 apply 以便重新计时、广播；有机器人亮了返回 true */
  private botsDeclareNow(): boolean {
    let declared = false;
    for (const [seat, slot] of this.seats.entries()) {
      if (!slot?.isBot || this.state?.phase !== 'declaring') continue;
      const a = smartDeclare(this.state, seat, this.rng);
      if (a && this.apply(a)) declared = true;
    }
    return declared;
  }

  /** 抢庄时发慢一点：首局从头到尾，非首局重新抢庄到定了庄家为止（GitHub issue #14） */
  private dealInterval(s: GameState): number {
    const grabbing = s.round === 1 || s.dealer === null;
    return grabbing ? (this.opts.grabDealIntervalMs ?? this.opts.dealIntervalMs) : this.opts.dealIntervalMs;
  }

  private dealTick(): void {
    this.dealTimer = null;
    if (!this.state || this.state.phase !== 'dealing') return;
    if (!this.humansOnline()) return; // 暂停，真人回来后由 join 重新触发
    this.botsMaybeDeclare();
    if (this.state.phase !== 'dealing') return;
    this.apply({ type: 'dealCard' });
  }

  private botsMaybeDeclare(): void {
    if (!this.state) return;
    for (const [seat, slot] of this.seats.entries()) {
      if (!slot?.isBot) continue;
      const a = smartDeclare(this.state, seat, this.rng);
      if (a) {
        const r = applyAction(this.state, a);
        if (r.ok) { this.record(a, r.state, r.events); this.state = r.state; this.broadcastState(r.events); }
      }
    }
  }

  private scheduleBot(): void {
    if (this.botTimer || !this.state) return;
    if (!this.humansOnline()) return; // 没有真人在线，机器人暂停
    if (this.botToAct() === null) return;
    // 加强模式下搜索本身就是思考时间，固定等待缩短
    const searching = this.botStrength === 'strong' && (this.state.phase === 'playing' || this.state.phase === 'bottom' || this.state.phase === 'callFriend');
    // 机器人坐庄第一次埋底：先等真人决定造不造反
    const hold = this.zaofanHoldMs();
    const delay = hold > 0 ? hold : searching ? Math.min(this.opts.botDelayMs, 100) : this.opts.botDelayMs;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (!this.state || !this.humansOnline()) return;
      const t = this.botToAct();
      if (t === null) return;
      if (this.botStrength === 'strong' && (this.state.phase === 'playing' || this.state.phase === 'bottom' || this.state.phase === 'callFriend')) {
        void this.searchAndPlay(t);
        return;
      }
      const a = smartAction(this.state, t, this.rng);
      if (a) this.apply(a);
    }, delay);
  }

  /** 现在该行动的机器人座位：一般是轮到的人；过河时同时问，挑第一个要行动的机器人 */
  private botToAct(): Seat | null {
    if (!this.state) return null;
    return waitingSeats(this.state).find((seat) => this.seats[seat]?.isBot) ?? null;
  }

  /** 搜索机器人出牌：异步跑，期间局面若变了（重发、结束、有人接管）就丢弃结果 */
  private async searchAndPlay(seat: Seat): Promise<void> {
    const state = this.state;
    if (!state) return;
    const epoch = ++this.searchEpoch;
    const pool = getSearchPool();
    const opts = tuneForMode(state, { timeBudgetMs: this.opts.searchBudgetMs, minSamples: 2, maxSamples: 120, maxCandidates: 8 });
    let action: Action;
    if (state.phase === 'bottom' || state.phase === 'callFriend') {
      // 扣底、叫朋友一局只做一次，预算给多一点
      const r = await pool.searchDealer(state, seat, this.rng, { ...opts, timeBudgetMs: opts.timeBudgetMs * 2, maxSamples: 60 });
      console.log(`[${this.code}] ${state.phase === 'bottom' ? '扣底' : '叫朋友'}搜索 座位${seat} 候选${r.candidates} 采样${r.samples} ${r.elapsedMs}ms ${r.workers}线程`);
      action = r.action;
    } else {
      const r = await pool.searchPlay(state, seat, this.rng, opts);
      console.log(`[${this.code}] 搜索 座位${seat} 候选${r.candidates} 采样${r.samples} ${r.elapsedMs}ms ${r.workers}线程`);
      action = r.action;
    }
    if (epoch !== this.searchEpoch || this.state !== state) return;
    if (!this.seats[seat]?.isBot || currentTurn(this.state) !== seat) return;
    this.apply(action);
  }

  /**
   * 最后一次出牌自动出：真人跟牌时手里的牌不多于首出张数（只能全出），或首出时只剩一张，
   * 都没有选择余地，稍等一下就代他出掉，省得再点一次。
   */
  private scheduleAutoPlay(): void {
    if (this.autoTimer || !this.state || this.state.phase !== 'playing') return;
    const turn = currentTurn(this.state);
    if (turn === null || this.seats[turn]?.isBot) return;
    const hand = this.state.hands[turn] ?? [];
    const trick = this.state.trick;
    let forced: readonly string[] | null = null;
    if (trick && trick.plays.length > 0 && trick.lead) {
      let n = 0;
      for (const c of trick.lead.components) n += c.cards.length;
      if (hand.length <= n) forced = hand.map((c) => c.id);
    } else if (hand.length === 1) {
      forced = hand.map((c) => c.id);
    }
    if (!forced) return;
    const state = this.state;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      if (this.state !== state) return;
      this.apply({ type: 'play', seat: turn, cards: forced as string[] });
    }, 700);
  }

  private clearTimer(which: 'deal' | 'grace'): void {
    if (which === 'deal' && this.dealTimer) { clearTimeout(this.dealTimer); this.dealTimer = null; }
    if (which === 'grace') {
      if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
      if (this.declareBotTimer) { clearTimeout(this.declareBotTimer); this.declareBotTimer = null; }
    }
  }

  dispose(): void {
    this.searchEpoch++;
    this.clearTimer('deal');
    this.clearTimer('grace');
    this.declareDeadline = null;
    this.declarePassed.clear();
    this.clearChaodiTimer();
    this.chaodiAsked = null;
    this.chaodiDeadline = null;
    if (this.guoheTimer) { clearTimeout(this.guoheTimer); this.guoheTimer = null; }
    this.guoheDeadline = null;
    this.zaofanPassed.clear();
    this.zaofanDeadline = null;
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer = null; }
  }
}

const hiddenCard = { id: 'hidden', suit: 'J' as const, rank: 0, deck: 0 };

/**
 * 旧存档里的四人局还在用找朋友的等级阶梯（5、10、K、2…），等级存的是旧阶梯的下标。
 * 换成四人升级的新阶梯（2 → A，必停 5、10、K），按点数把每个人的等级换成新下标，显示的级别不变。
 */
/** 旧存档里的五人局没有连庄规则：补上（第 16 条）。已算好的下一局庄家不改 */
export function migrateDealerRule(state: GameState): GameState {
  if (state.config.players !== 5 || state.config.mode !== 'friends' || state.config.dealerKeepsOnHold !== undefined) return state;
  return { ...state, config: { ...state.config, dealerKeepsOnHold: true } };
}

export function migrateLadder(state: GameState): GameState {
  if (state.config.mode !== 'partners' || state.config.levelSequence) return state;
  const fresh = defaultConfig(4);
  const seq = fresh.levelSequence as readonly number[];
  const remap = (idx: number) => {
    const rank = LEVEL_SEQUENCE[idx];
    const j = rank === undefined ? -1 : seq.indexOf(rank);
    return j >= 0 ? j : idx;
  };
  const lastRound = state.lastRound
    ? { ...state.lastRound, levelsBefore: state.lastRound.levelsBefore.map(remap), levelsAfter: state.lastRound.levelsAfter.map(remap) }
    : state.lastRound;
  return { ...state, config: { ...state.config, levelSequence: fresh.levelSequence, levelStops: fresh.levelStops }, levels: state.levels.map(remap), lastRound };
}
