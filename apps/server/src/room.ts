/** 一个房间：大厅座位管理 + 驾驭引擎状态机 + 机器人 + 广播。 */
import {
  applyAction, createGame, createRng, currentTurn, defaultConfig, LEVEL_SEQUENCE, restartRound, smartAction, smartDeclare, tuneForMode, viewFor,
  type Action, type GameConfig, type GameEvent, type GameState, type Rng, type Seat,
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
  readonly declareGraceMs: number;
  readonly botDelayMs: number;
  /** 搜索机器人每手的时间预算 */
  readonly searchBudgetMs: number;
}

export const defaultRoomOptions: RoomOptions = { dealIntervalMs: 150, declareGraceMs: 5000, botDelayMs: 900, searchBudgetMs: 1100 };

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
  /** 正在进行的异步搜索的序号，用来丢弃过期结果 */
  private searchEpoch = 0;
  private readonly rng: Rng;
  private dealTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
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
    return this.seats.some((slot) => {
      if (!slot || slot.isBot) return false;
      const m = this.members.get(slot.token);
      return Boolean(m?.socket && m.socket.readyState === m.socket.OPEN);
    });
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
      you: this.seatOf(forToken),
      youAreHost: forToken === this.hostToken,
    };
  }

  setBots(token: string, strength: 'normal' | 'strong'): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能设置机器人');
    this.botStrength = strength;
    this.broadcastRoom();
  }

  /** 房主可以关，没有真人在线的房间谁都可以关 */
  canClose(token: string): boolean {
    return token === this.hostToken || !this.humansOnline();
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

  private broadcastState(events: readonly GameEvent[]): void {
    if (!this.state) return;
    this.seq++;
    for (const [seat, slot] of this.seats.entries()) {
      if (!slot || slot.isBot) continue;
      const m = this.members.get(slot.token);
      if (!m) continue;
      const filtered = events.map((e) => (e.type === 'cardDealt' && e.seat !== seat ? { ...e, card: hiddenCard } : e));
      this.send(m, { t: 'state', seq: this.seq, view: viewFor(this.state, seat), events: filtered });
    }
  }

  /** 重连或首次连接时补发当前状态 */
  sync(token: string): void {
    const m = this.members.get(token);
    this.send(m, { t: 'room', room: this.info(token) });
    const seat = this.seatOf(token);
    if (this.state && seat !== null) {
      this.send(m, { t: 'state', seq: this.seq, view: viewFor(this.state, seat), events: [] });
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

  detach(token: string): void {
    const m = this.members.get(token);
    if (m) m.socket = null;
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
    if (events.some((e) => e.type === 'dealerChanged' || e.type === 'redeal')) this.beginRoundLog(next);
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
    this.broadcastState(events);
    this.onChange();
    this.armTimers();
  }

  /** 按当前阶段挂上需要的定时器：发牌、亮主缓冲、机器人出牌、自动下一局 */
  private armTimers(): void {
    const s = this.state;
    if (!s) return;
    switch (s.phase) {
      case 'dealing':
        this.clearTimer('grace');
        if (!this.dealTimer) this.dealTimer = setTimeout(() => this.dealTick(), this.opts.dealIntervalMs);
        break;
      case 'declaring':
        this.clearTimer('deal');
        if (!this.graceTimer) {
          this.graceTimer = setTimeout(() => {
            this.graceTimer = null;
            if (!this.humansOnline()) return;
            this.botsMaybeDeclare();
            this.apply({ type: 'closeDeclaring' });
          }, this.opts.declareGraceMs);
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
    const turn = currentTurn(this.state);
    if (turn === null || !this.seats[turn]?.isBot) return;
    // 加强模式下搜索本身就是思考时间，固定等待缩短
    const searching = this.botStrength === 'strong' && (this.state.phase === 'playing' || this.state.phase === 'bottom' || this.state.phase === 'callFriend');
    const delay = searching ? Math.min(this.opts.botDelayMs, 100) : this.opts.botDelayMs;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (!this.state || !this.humansOnline()) return;
      const t = currentTurn(this.state);
      if (t === null || !this.seats[t]?.isBot) return;
      if (this.botStrength === 'strong' && (this.state.phase === 'playing' || this.state.phase === 'bottom' || this.state.phase === 'callFriend')) {
        void this.searchAndPlay(t);
        return;
      }
      const a = smartAction(this.state, t, this.rng);
      if (a) this.apply(a);
    }, delay);
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
    if (which === 'grace' && this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
  }

  dispose(): void {
    this.searchEpoch++;
    this.clearTimer('deal');
    this.clearTimer('grace');
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
