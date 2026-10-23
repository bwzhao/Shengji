/** 房间快照落盘：进程重启后恢复正在进行的牌局。 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DdzState, GameState } from '@shengji/engine';
import type { GameKind, RoundReplay } from '@shengji/protocol';

export interface RoomSnapshot {
  readonly code: string;
  /** 旧存档里没有，都是升级 */
  readonly game?: GameKind;
  readonly players: 3 | 4 | 5 | 6;
  readonly hostToken: string;
  readonly seats: readonly ({ token: string; isBot: boolean; name?: string } | null)[];
  readonly members: readonly { token: string; name: string }[];
  /** 升级的牌局 */
  readonly state: GameState | null;
  /** 斗地主的牌局 */
  readonly ddz?: DdzState | null;
  readonly seq: number;
  readonly lastActivity: number;
  readonly roundLogs?: readonly RoundReplay[];
  readonly botStrength?: 'normal' | 'strong';
  /** 旧存档里没有，按锁住处理 */
  readonly playLogOpen?: boolean;
}

export interface SessionSnapshot {
  readonly token: string;
  readonly name: string;
  readonly roomCode: string | null;
  readonly lastSeen: number;
  /** 登录的账号；旧快照和游客没有 */
  readonly accountId?: string;
}

export interface Snapshot {
  readonly version: 1;
  readonly savedAt: number;
  readonly rooms: readonly RoomSnapshot[];
  readonly sessions: readonly SessionSnapshot[];
}

export class Store {
  private readonly file: string;
  private timer: NodeJS.Timeout | null = null;
  private pending: (() => Snapshot) | null = null;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'rooms.json');
  }

  load(): Snapshot | null {
    if (!existsSync(this.file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
      return parsed.version === 1 ? parsed : null;
    } catch (err) {
      console.error('读取快照失败，忽略：', (err as Error).message);
      return null;
    }
  }

  /** 合并一秒内的多次变化，只写一次 */
  schedule(make: () => Snapshot): void {
    this.pending = make;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1000);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const make = this.pending;
    this.pending = null;
    if (!make) return;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(make()));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('写快照失败：', (err as Error).message);
    }
  }
}
