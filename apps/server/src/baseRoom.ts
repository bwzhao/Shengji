/**
 * 房间的公共部分：大厅座位、成员、房主、机器人座位、观看者、房间信息。
 * 具体玩什么（升级找朋友、斗地主）由子类管：开局、牌局状态、定时器、存档。
 */
import { createRng, type Rng, type Seat } from '@shengji/engine';
import type { GameKind, RoomInfo, RoomSummary, ServerMessage } from '@shengji/protocol';
import type { WebSocket } from 'ws';
import type { RoomSnapshot } from './store.ts';
import { pickStarName } from './stars.ts';

export interface Member {
  readonly token: string;
  name: string;
  socket: WebSocket | null;
  /** 没坐下的人（观看者）正在看哪个座位的手牌；不设时看房主的座位 */
  watching?: Seat;
}

export interface SeatSlot {
  readonly token: string;
  readonly isBot: boolean;
  /** 机器人的明星名字 */
  readonly name?: string;
}

export abstract class BaseRoom {
  readonly code: string;
  readonly playerCount: 3 | 4 | 5 | 6;
  readonly members = new Map<string, Member>();
  readonly seats: (SeatSlot | null)[];
  hostToken: string;
  seq = 0;
  lastActivity = Date.now();
  protected readonly rng: Rng;
  /** 任何需要落盘的变化后调用 */
  onChange: () => void = () => {};

  abstract readonly game: GameKind;
  abstract get started(): boolean;
  /** 重连或首次连接时补发房间和牌局 */
  abstract sync(token: string): void;
  abstract start(token: string): void;
  /** 房主开下一局 */
  abstract nextRound(token: string): void;
  /** 房主结束游戏回大厅 */
  abstract abortGame(token: string): void;
  /** 清掉所有定时器 */
  abstract dispose(): void;
  abstract toSnapshot(): RoomSnapshot;
  /** 恢复存档后重新挂上定时器 */
  abstract resume(): void;
  /** 牌局中座位换了人（离开由机器人接管、进来接管机器人）：重新安排机器人并广播 */
  protected abstract seatsChanged(): void;
  /** 真人回来了：牌局如果因为没人在线暂停，重新挂上定时器 */
  protected abstract humanBack(): void;
  /** 关闭房间时丢掉牌局 */
  protected abstract clearGame(): void;
  /** 房间信息里和玩法有关的部分 */
  protected abstract gameInfo(): Pick<RoomInfo, 'botStrength' | 'playLogOpen'>;
  /** 首页房间列表里的局数和阶段 */
  protected abstract gameSummary(): Pick<RoomSummary, 'round' | 'phase'>;

  constructor(code: string, players: 3 | 4 | 5 | 6, hostToken: string) {
    this.code = code;
    this.playerCount = players;
    this.hostToken = hostToken;
    this.seats = Array.from({ length: players }, () => null);
    this.rng = createRng(`bots/${code}/${Date.now()}`);
  }

  /** 新建一个机器人座位，名字从明星表里挑一个本房间没用过的 */
  protected makeBot(seat: Seat): SeatSlot {
    const used = new Set<string>();
    for (const s of this.seats) if (s?.isBot && s.name) used.add(s.name);
    return { token: `bot:${seat}`, isBot: true, name: pickStarName(used, () => this.rng.next(), `机器人${seat + 1}`) };
  }

  /** 有没有真人在线：没有的话机器人暂停，不再空转 */
  humansOnline(): boolean {
    return this.onlineHumanSeats().length > 0;
  }

  protected onlineHumanSeats(): Seat[] {
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

  protected send(m: Member | undefined, msg: ServerMessage): void {
    if (m?.socket && m.socket.readyState === m.socket.OPEN) m.socket.send(JSON.stringify(msg));
  }

  protected error(token: string, code: string, message: string): void {
    this.send(this.members.get(token), { t: 'error', code, message });
  }

  protected nameOfSeat(seat: Seat, slot: SeatSlot | null): string {
    if (!slot) return `${seat + 1} 号`;
    if (slot.isBot) return slot.name ?? `机器人${seat + 1}`;
    return this.members.get(slot.token)?.name ?? `${seat + 1} 号`;
  }

  info(forToken: string): RoomInfo {
    return {
      code: this.code,
      game: this.game,
      players: this.playerCount,
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
      ...this.gameInfo(),
      spectators: this.spectators().map((m) => m.name),
      you: this.seatOf(forToken),
      youAreHost: forToken === this.hostToken,
    };
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
    this.clearGame();
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
      game: this.game,
      players: this.playerCount,
      started: this.started,
      ...this.gameSummary(),
      humans,
      humansOnline: online,
      bots,
      names,
      hostName: hostSeat !== null ? this.nameOfSeat(hostSeat, this.seats[hostSeat] ?? null) : (this.members.get(this.hostToken)?.name ?? '?'),
      joinable: this.seats.some((s) => !s || s.isBot),
      spectators: this.started ? this.spectators().length : 0,
      canClose: this.canClose(forToken),
      lastActivity: this.lastActivity,
    };
  }

  broadcastRoom(): void {
    for (const m of this.members.values()) this.send(m, { t: 'room', room: this.info(m.token) });
    this.onChange();
  }

  /** 在线、没坐下的人；开局后就是观看者 */
  protected spectators(): Member[] {
    return [...this.members.values()].filter((m) => m.socket && m.socket.readyState === m.socket.OPEN && this.seatOf(m.token) === null);
  }

  /** 观看者正在看的座位：自己选的，没选就看房主，房主不在座位上就看 0 号位 */
  protected watchedSeat(m: Member): Seat {
    return m.watching ?? this.seatOf(this.hostToken) ?? 0;
  }

  /** 观看者换着看某个座位的手牌 */
  watch(token: string, seat: Seat): void {
    const m = this.members.get(token);
    if (!m || this.seatOf(token) !== null) return this.error(token, 'NOT_SPECTATOR', '你在座位上，不能换着看别人的牌');
    if (seat < 0 || seat >= this.playerCount) return this.error(token, 'BAD_SEAT', '没有这个座位');
    m.watching = seat;
    this.sync(token);
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
    if (socket && this.started && this.seatOf(token) !== null) this.humanBack();
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
      this.seatsChanged();
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
    this.broadcastRoom();
    this.seatsChanged();
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

  /** 开局前的公共检查：房主、还没开始、坐满了 */
  protected canStart(token: string): boolean {
    if (token !== this.hostToken) { this.error(token, 'NOT_HOST', '只有房主能开始'); return false; }
    if (this.started) { this.error(token, 'STARTED', '游戏已经开始'); return false; }
    if (this.seats.some((s) => !s)) { this.error(token, 'NOT_FULL', '人还没坐满'); return false; }
    return true;
  }
}
