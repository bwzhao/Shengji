/** 客户端与服务端之间的 WebSocket 消息。全部 JSON 文本帧，t 字段区分类型。 */
import { z } from 'zod';
import type { Action, GameEvent, GameState, PlayerView, Seat } from '@shengji/engine';

const cardIds = z.array(z.string().min(1)).min(1).max(40);
const suit = z.enum(['S', 'H', 'D', 'C']);

export const friendCallSchema = z.object({
  suit,
  rank: z.number().int().min(2).max(14),
  nth: z.number().int().min(1).max(3),
});

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), name: z.string().trim().min(1).max(12), token: z.string().min(8).max(64).optional() }),
  z.object({ t: z.literal('createRoom'), players: z.union([z.literal(4), z.literal(5), z.literal(6)]) }),
  z.object({ t: z.literal('listRooms') }),
  z.object({ t: z.literal('closeRoom'), code: z.string().trim().length(4).optional() }),
  z.object({ t: z.literal('joinRoom'), code: z.string().trim().length(4) }),
  z.object({ t: z.literal('leaveRoom') }),
  z.object({ t: z.literal('sit'), seat: z.number().int().min(0).max(5) }),
  z.object({ t: z.literal('stand') }),
  z.object({ t: z.literal('addBot'), seat: z.number().int().min(0).max(5) }),
  z.object({ t: z.literal('removeBot'), seat: z.number().int().min(0).max(5) }),
  z.object({ t: z.literal('start') }),
  z.object({ t: z.literal('setBots'), strength: z.enum(['normal', 'strong']) }),
  z.object({ t: z.literal('declare'), cards: cardIds }),
  /** 亮主阶段「不反」：在线真人都点了就提前结束倒计时 */
  z.object({ t: z.literal('passDeclare') }),
  z.object({ t: z.literal('exchangeBottom'), cards: cardIds }),
  z.object({ t: z.literal('callFriend'), calls: z.array(friendCallSchema).min(1).max(2) }),
  z.object({ t: z.literal('play'), cards: cardIds }),
  z.object({ t: z.literal('nextRound') }),
  z.object({ t: z.literal('restartRound') }),
  z.object({ t: z.literal('abortGame') }),
  z.object({ t: z.literal('getReplay'), round: z.number().int().min(1) }),
  z.object({ t: z.literal('ping') }),
]);

/** 一局的回放：从发牌前的完整状态出发，依次重放操作即可复现。 */
export interface RoundReplay {
  readonly round: number;
  readonly initial: GameState;
  readonly actions: readonly Action[];
  readonly names: readonly string[];
}

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface RoomPlayer {
  readonly seat: Seat;
  readonly name: string;
  readonly connected: boolean;
  readonly isBot: boolean;
  readonly isHost: boolean;
}

export interface RoomInfo {
  readonly code: string;
  readonly players: 4 | 5 | 6;
  readonly seats: readonly (RoomPlayer | null)[];
  readonly started: boolean;
  /** 机器人强度：normal 规则机器人反应快；strong 搜索机器人更会打但每手多想一秒 */
  readonly botStrength: 'normal' | 'strong';
  /** 自己的座位，未坐下为 null */
  readonly you: Seat | null;
  readonly youAreHost: boolean;
}

/** 首页显示的服务器房间概览 */
export interface RoomSummary {
  readonly code: string;
  readonly players: 4 | 5 | 6;
  readonly started: boolean;
  readonly round: number;
  readonly phase: string | null;
  readonly humans: number;
  readonly humansOnline: number;
  readonly bots: number;
  readonly names: readonly string[];
  readonly hostName: string;
  /** 有空位或机器人座位可以进 */
  readonly joinable: boolean;
  /** 请求者能否关闭：自己是房主，或者房间里没有任何真人在线 */
  readonly canClose: boolean;
  readonly lastActivity: number;
}

export type ServerMessage =
  | { readonly t: 'welcome'; readonly token: string; readonly name: string }
  | { readonly t: 'room'; readonly room: RoomInfo | null }
  /** declareLeftMs：发完牌后亮主思考时间还剩多少毫秒；declarePassed：点了「不反」的座位。都只在 declaring 阶段有 */
  | { readonly t: 'state'; readonly seq: number; readonly view: PlayerView; readonly events: readonly GameEvent[]; readonly declareLeftMs?: number; readonly declarePassed?: readonly Seat[] }
  | { readonly t: 'error'; readonly code: string; readonly message: string }
  | { readonly t: 'replay'; readonly replay: RoundReplay }
  | { readonly t: 'rooms'; readonly rooms: readonly RoomSummary[] }
  | { readonly t: 'pong' };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const r = clientMessageSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
