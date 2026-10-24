/** 房间与会话登记。 */
import { randomBytes } from 'node:crypto';
import type { BaseRoom } from './baseRoom.ts';
import { DdzRoom } from './ddzRoom.ts';
import { Room, defaultRoomOptions, type RoomOptions } from './room.ts';
import type { RoomRules } from '@shengji/protocol';
import type { Snapshot, Store } from './store.ts';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

export interface Session {
  readonly token: string;
  name: string;
  roomCode: string | null;
  lastSeen: number;
  /** 登录了哪个账号；游客没有 */
  accountId?: string;
}

export class Registry {
  readonly rooms = new Map<string, BaseRoom>();
  readonly sessions = new Map<string, Session>();
  private readonly roomOptions: RoomOptions;
  private readonly store: Store | null;
  /** 账号 id → 头像网址（由服务端接上账号） */
  accountAvatar: (accountId: string) => string | null = () => null;

  constructor(roomOptions: RoomOptions = defaultRoomOptions, store: Store | null = null) {
    this.roomOptions = roomOptions;
    this.store = store;
  }

  /** 启动时从快照恢复 */
  restore(): number {
    const snap = this.store?.load();
    if (!snap) return 0;
    for (const s of snap.sessions) this.sessions.set(s.token, { ...s });
    for (const r of snap.rooms) {
      const room = r.game === 'doudizhu' ? DdzRoom.fromSnapshot(r, this.roomOptions) : Room.fromSnapshot(r, this.roomOptions);
      this.attach(room);
      this.rooms.set(room.code, room);
    }
    for (const room of this.rooms.values()) room.resume();
    return this.rooms.size;
  }

  private attach(room: BaseRoom): void {
    room.onChange = () => this.scheduleSave();
    room.isRegistered = (token) => Boolean(this.sessions.get(token)?.accountId);
    room.avatarOf = (token) => {
      const id = this.sessions.get(token)?.accountId;
      return id ? this.accountAvatar(id) : null;
    };
  }

  snapshot(): Snapshot {
    return {
      version: 1,
      savedAt: Date.now(),
      rooms: [...this.rooms.values()].map((r) => r.toSnapshot()),
      sessions: [...this.sessions.values()],
    };
  }

  scheduleSave(): void {
    this.store?.schedule(() => this.snapshot());
  }

  flush(): void {
    this.store?.schedule(() => this.snapshot());
    this.store?.flush();
  }

  newToken(): string {
    return randomBytes(18).toString('base64url');
  }

  newCode(): string {
    for (;;) {
      let code = '';
      const bytes = randomBytes(4);
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[(bytes[i] as number) % CODE_ALPHABET.length];
      if (!this.rooms.has(code)) return code;
    }
  }

  /** 3 人开斗地主，4~6 人开升级；rules 是四人升级的抄底、过河 */
  createRoom(hostToken: string, players: 3 | 4 | 5 | 6, rules?: Partial<RoomRules>): BaseRoom {
    const room = players === 3 ? new DdzRoom(this.newCode(), hostToken, this.roomOptions) : new Room(this.newCode(), players, hostToken, this.roomOptions, rules);
    this.attach(room);
    this.rooms.set(room.code, room);
    this.scheduleSave();
    return room;
  }

  /** 这个账号所在的房间（一个账号只有一个会话） */
  roomsOfAccount(accountId: string): BaseRoom[] {
    const rooms: BaseRoom[] = [];
    for (const s of this.sessions.values()) {
      const r = s.accountId === accountId && s.roomCode ? this.rooms.get(s.roomCode) : undefined;
      if (r) rooms.push(r);
    }
    return rooms;
  }

  /** 关闭房间并把成员的会话从房间里解绑 */
  closeRoom(code: string, reason: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.close(reason);
    this.rooms.delete(code);
    for (const s of this.sessions.values()) if (s.roomCode === code) s.roomCode = null;
    this.scheduleSave();
  }

  /** 回收空闲两小时的房间与一天没露面的会话 */
  gc(now = Date.now()): void {
    for (const [code, room] of this.rooms) {
      const empty = [...room.members.values()].every((m) => !m.socket);
      if (empty && now - room.lastActivity > 2 * 3600_000) {
        room.dispose();
        this.rooms.delete(code);
        this.scheduleSave();
      }
    }
    for (const [token, s] of this.sessions) {
      if (now - s.lastSeen > 24 * 3600_000 && (!s.roomCode || !this.rooms.has(s.roomCode))) this.sessions.delete(token);
    }
  }
}
