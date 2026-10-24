/** 斗地主的房间：三个人，驾驭斗地主状态机 + 机器人 + 广播；大厅座位管理在 BaseRoom。 */
import {
  applyDdzAction, createDdzGame, ddzBotAction, ddzCanFollow, ddzViewFor,
  type DdzAction, type DdzEvent, type DdzState, type Seat,
} from '@shengji/engine';
import type { RoomInfo, RoomSummary } from '@shengji/protocol';
import { BaseRoom } from './baseRoom.ts';
import { defaultRoomOptions, type RoomOptions } from './room.ts';
import type { RoomSnapshot } from './store.ts';

export class DdzRoom extends BaseRoom {
  readonly game = 'doudizhu' as const;
  state: DdzState | null = null;
  private botTimer: NodeJS.Timeout | null = null;
  /** 真人管不住上家时自动「要不起」 */
  private autoTimer: NodeJS.Timeout | null = null;
  /** 房主不在座位上时自动开下一局 */
  private nextTimer: NodeJS.Timeout | null = null;
  private readonly opts: RoomOptions;

  constructor(code: string, hostToken: string, opts: RoomOptions = defaultRoomOptions) {
    super(code, 3, hostToken);
    this.opts = opts;
  }

  get started(): boolean {
    return this.state !== null;
  }

  protected gameInfo(): Pick<RoomInfo, 'botStrength' | 'playLogOpen' | 'rules'> {
    return { botStrength: 'normal', playLogOpen: true, rules: null };
  }

  protected gameSummary(): Pick<RoomSummary, 'round' | 'phase' | 'rules'> {
    return { round: this.state?.round ?? 0, phase: this.state?.phase ?? null, rules: null };
  }

  protected seatsChanged(): void {
    this.clearTimers();
    this.afterChange([]);
  }

  protected humanBack(): void {
    this.armTimers();
  }

  protected clearGame(): void {
    this.state = null;
  }

  toSnapshot(): RoomSnapshot {
    return {
      code: this.code,
      game: 'doudizhu',
      players: 3,
      hostToken: this.hostToken,
      seats: this.seats.map((s) => (s ? { token: s.token, isBot: s.isBot, name: s.name } : null)),
      members: [...this.members.values()].map((m) => ({ token: m.token, name: m.name })),
      state: null,
      ddz: this.state,
      seq: this.seq,
      lastActivity: this.lastActivity,
    };
  }

  static fromSnapshot(snap: RoomSnapshot, opts: RoomOptions): DdzRoom {
    const room = new DdzRoom(snap.code, snap.hostToken, opts);
    snap.seats.forEach((s, i) => { room.seats[i] = s ? { token: s.token, isBot: s.isBot, name: s.name } : null; });
    for (const m of snap.members) room.members.set(m.token, { token: m.token, name: m.name, socket: null });
    room.state = snap.ddz ?? null;
    room.seq = snap.seq;
    room.lastActivity = snap.lastActivity;
    return room;
  }

  resume(): void {
    if (this.state) this.afterChange([]);
  }

  start(token: string): void {
    if (!this.canStart(token)) return;
    this.state = createDdzGame(`${this.code}/${Date.now()}`);
    this.lastActivity = Date.now();
    this.broadcastRoom();
    this.afterChange([{ type: 'dealt', firstBidder: this.state.firstBidder }]);
  }

  /** 叫分、出牌、不出（座位由 server 按连接填好） */
  act(token: string, action: DdzAction): void {
    if (!this.state) return this.error(token, 'NOT_STARTED', '游戏还没开始');
    const r = applyDdzAction(this.state, action);
    if (!r.ok) return this.error(token, r.error.code, r.error.message);
    this.state = r.state;
    this.lastActivity = Date.now();
    this.afterChange(r.events);
  }

  nextRound(token: string): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '由房主开始下一局');
    this.act(token, { type: 'nextRound' });
  }

  /** 房主结束游戏：回到大厅，座位与机器人保留，积分清零 */
  abortGame(token: string): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能结束游戏');
    if (!this.state) return this.error(token, 'NOT_STARTED', '游戏还没开始');
    this.dispose();
    this.state = null;
    this.seq++;
    this.lastActivity = Date.now();
    this.broadcastRoom();
  }

  sync(token: string): void {
    const m = this.members.get(token);
    this.send(m, { t: 'room', room: this.info(token) });
    if (!this.state || !m) return;
    const seat = this.seatOf(token) ?? this.watchedSeat(m);
    this.send(m, { t: 'ddzState', seq: this.seq, view: ddzViewFor(this.state, seat), events: [] });
  }

  private broadcastState(events: readonly DdzEvent[]): void {
    if (!this.state) return;
    this.seq++;
    for (const [seat, slot] of this.seats.entries()) {
      if (!slot || slot.isBot) continue;
      this.send(this.members.get(slot.token), { t: 'ddzState', seq: this.seq, view: ddzViewFor(this.state, seat), events });
    }
    for (const m of this.spectators()) {
      this.send(m, { t: 'ddzState', seq: this.seq, view: ddzViewFor(this.state, this.watchedSeat(m)), events });
    }
  }

  private afterChange(events: readonly DdzEvent[]): void {
    this.broadcastState(events);
    this.onChange();
    this.armTimers();
  }

  private apply(action: DdzAction): void {
    if (!this.state) return;
    const r = applyDdzAction(this.state, action);
    if (!r.ok) {
      console.error(`[${this.code}] 斗地主内部操作失败 ${action.type}: ${r.error.code} ${r.error.message}`);
      return;
    }
    this.state = r.state;
    this.afterChange(r.events);
  }

  private clearTimers(): void {
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer = null; }
    if (this.nextTimer) { clearTimeout(this.nextTimer); this.nextTimer = null; }
  }

  /** 轮到机器人就稍等一下替它出；真人管不住就自动「要不起」；打完一局房主不在座位上就自动开下一局 */
  private armTimers(): void {
    const s = this.state;
    if (!s) return;
    this.clearTimers();
    if (!this.humansOnline()) return; // 没有真人在线，暂停
    if (s.phase === 'roundEnd') {
      if (this.seatOf(this.hostToken) === null) {
        this.nextTimer = setTimeout(() => { this.nextTimer = null; if (this.humansOnline()) this.apply({ type: 'nextRound' }); }, 8000);
      }
      return;
    }
    const turn: Seat = s.turn;
    if (this.seats[turn]?.isBot) {
      this.botTimer = setTimeout(() => {
        this.botTimer = null;
        if (!this.state || this.state.turn !== turn || !this.seats[turn]?.isBot) return;
        const a = ddzBotAction(this.state, turn);
        if (a) this.apply(a);
      }, this.opts.botDelayMs);
      return;
    }
    const last = s.lastPlay;
    if (s.phase === 'playing' && last && last.seat !== turn && !ddzCanFollow(s.hands[turn] ?? [], last.combo)) {
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        if (this.state?.phase === 'playing' && this.state.turn === turn) this.apply({ type: 'pass', seat: turn });
      }, this.opts.ddzAutoPassMs ?? 1000);
    }
  }

  dispose(): void {
    this.clearTimers();
  }
}
