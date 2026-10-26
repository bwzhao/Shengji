/** 客户端与服务端之间的 WebSocket 消息。全部 JSON 文本帧，t 字段区分类型。 */
import { z } from 'zod';
import type { Action, DdzEvent, DdzView, GameEvent, GameState, PlayerView, Seat } from '@shengji/engine';

/** 玩法：升级·找朋友（4~6 人），斗地主（3 人） */
export type GameKind = 'shengji' | 'doudizhu';

const cardIds = z.array(z.string().min(1)).min(1).max(40);
const suit = z.enum(['S', 'H', 'D', 'C']);

export const friendCallSchema = z.object({
  suit,
  rank: z.number().int().min(2).max(14),
  nth: z.number().int().min(1).max(3),
});

/** 造反的分数线：手里分数不多于 low 或不少于 high（庄家拿着底牌时不少于 dealerHigh）才能造反 */
const zaofanScore = z.number().int().min(0).max(300);
export const zaofanRuleSchema = z.object({ low: zaofanScore, high: zaofanScore, dealerHigh: zaofanScore });
export type ZaofanRule = z.infer<typeof zaofanRuleSchema>;

/**
 * 升级的可选规则，开房时选，开局前房主还能改，开局后锁住。
 * 抄底、过河只有四人局有（五、六人局固定为 false）；造反各人数都有，null 是不能造反。
 */
export const roomRulesSchema = z.object({ chaodi: z.boolean(), guohe: z.boolean(), zaofan: zaofanRuleSchema.nullable() });
export type RoomRules = z.infer<typeof roomRulesSchema>;

/** 造反分数线合不合理；players 决定总分（四人两副牌 200 分，五、六人三副牌 300 分） */
export function zaofanRuleError(rule: ZaofanRule, players: 4 | 5 | 6): string | null {
  const total = players === 4 ? 200 : 300;
  const { low, high, dealerHigh } = rule;
  if (![low, high, dealerHigh].every((n) => Number.isInteger(n) && n >= 0)) return '造反分数要是整数';
  if (high <= low) return '造反的上限要比下限大';
  if (dealerHigh < high) return '庄家（拿着底牌）的上限不能比别人低';
  if (dealerHigh > total) return `造反分数不能超过总分 ${total}`;
  return null;
}

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), name: z.string().trim().min(1).max(12), token: z.string().min(8).max(64).optional() }),
  /** 账号：注册（同时登录）、登录、退出登录、改显示名字、改密码。登录名和显示名字是两回事 */
  z.object({ t: z.literal('register'), username: z.string().trim().min(1).max(40), password: z.string().min(1).max(100), displayName: z.string().trim().min(1).max(12) }),
  z.object({ t: z.literal('login'), username: z.string().trim().min(1).max(40), password: z.string().min(1).max(100) }),
  z.object({ t: z.literal('logout') }),
  z.object({ t: z.literal('setDisplayName'), displayName: z.string().trim().min(1).max(12) }),
  z.object({ t: z.literal('changePassword'), oldPassword: z.string().min(1).max(100), newPassword: z.string().min(1).max(100) }),
  /** 换头像：浏览器裁好、压好的图片的 base64（最多 64 KB，base64 后约 87 KB）；null 是删掉头像 */
  z.object({ t: z.literal('setAvatar'), data: z.string().min(1).max(90_000).nullable() }),
  /** 管理员：账号列表、重置密码（给一个临时密码）、停用或恢复账号、删掉不合适的头像 */
  z.object({ t: z.literal('adminListAccounts') }),
  z.object({ t: z.literal('adminResetPassword'), username: z.string().trim().min(1).max(40) }),
  z.object({ t: z.literal('adminSetDisabled'), username: z.string().trim().min(1).max(40), disabled: z.boolean() }),
  z.object({ t: z.literal('adminRemoveAvatar'), username: z.string().trim().min(1).max(40) }),
  /** 3 人开斗地主房间，4~6 人开升级；rules 只对升级有用，不传的按这个人数的默认 */
  z.object({ t: z.literal('createRoom'), players: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(6)]), rules: roomRulesSchema.partial().optional() }),
  z.object({ t: z.literal('listRooms') }),
  z.object({ t: z.literal('closeRoom'), code: z.string().trim().length(4).optional() }),
  /** watch：只观看，不接管机器人座位。开局后又没有机器人座位可接管时，不带 watch 也会进来观看 */
  z.object({ t: z.literal('joinRoom'), code: z.string().trim().length(4), watch: z.boolean().optional() }),
  z.object({ t: z.literal('leaveRoom') }),
  z.object({ t: z.literal('sit'), seat: z.number().int().min(0).max(5) }),
  z.object({ t: z.literal('stand') }),
  z.object({ t: z.literal('addBot'), seat: z.number().int().min(0).max(5) }),
  z.object({ t: z.literal('removeBot'), seat: z.number().int().min(0).max(5) }),
  z.object({ t: z.literal('start') }),
  z.object({ t: z.literal('setBots'), strength: z.enum(['normal', 'strong']) }),
  /** 房主设置出牌记录能不能看别人出的牌 */
  z.object({ t: z.literal('setPlayLog'), open: z.boolean() }),
  /** 房主开局前改升级的可选规则 */
  z.object({ t: z.literal('setRules'), rules: roomRulesSchema.partial() }),
  /** 观看者换着看某个座位的手牌 */
  z.object({ t: z.literal('watch'), seat: z.number().int().min(0).max(5) }),
  z.object({ t: z.literal('declare'), cards: cardIds }),
  /** 亮主阶段「不反」：在线真人都点了就提前结束倒计时 */
  z.object({ t: z.literal('passDeclare') }),
  /** 四人抄底：轮到自己时用一对常主抄底，或不抄 */
  z.object({ t: z.literal('chaodi'), cards: cardIds }),
  z.object({ t: z.literal('passChaodi') }),
  /** 四人过河：主少的人给对家 5 张（含全部主牌），对家还 5 张副牌；或不过 */
  z.object({ t: z.literal('guohe'), cards: cardIds }),
  z.object({ t: z.literal('guoheReturn'), cards: cardIds }),
  z.object({ t: z.literal('passGuohe') }),
  /** 造反：手里分数太少或太多时推倒重来；机器人坐庄时可以点「不造反」让它不用等 */
  z.object({ t: z.literal('zaofan') }),
  z.object({ t: z.literal('passZaofan') }),
  z.object({ t: z.literal('exchangeBottom'), cards: cardIds }),
  z.object({ t: z.literal('callFriend'), calls: z.array(friendCallSchema).min(1).max(2) }),
  z.object({ t: z.literal('play'), cards: cardIds }),
  /** 斗地主：叫分（0 是不叫）、出牌、不出 */
  z.object({ t: z.literal('bid'), points: z.number().int().min(0).max(3) }),
  z.object({ t: z.literal('ddzPlay'), cards: cardIds }),
  z.object({ t: z.literal('ddzPass') }),
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
  /** 没登录账号的真人 */
  readonly guest: boolean;
  /** 注册用户上传的头像网址；没有为 null（机器人用明星照片，其他人用名字首字） */
  readonly avatar: string | null;
}

/** 已登录的账号：登录名只用来登录，显示名字是牌桌上看到的 */
export interface AccountInfo {
  readonly username: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly avatar: string | null;
}

/** 管理页里的一行 */
export interface AdminAccountRow {
  readonly username: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly disabled: boolean;
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
  readonly avatar: string | null;
}

export interface RoomInfo {
  readonly code: string;
  readonly game: GameKind;
  readonly players: 3 | 4 | 5 | 6;
  readonly seats: readonly (RoomPlayer | null)[];
  readonly started: boolean;
  /** 机器人强度：normal 规则机器人反应快；strong 搜索机器人更会打但每手多想一秒 */
  readonly botStrength: 'normal' | 'strong';
  /** 出牌记录能不能看别人出的牌；默认 false，只看自己的 */
  readonly playLogOpen: boolean;
  /** 升级的可选规则；斗地主为 null */
  readonly rules: RoomRules | null;
  /** 在线、没坐下的人（开局后就是观看者）的名字 */
  readonly spectators: readonly string[];
  /** 自己的座位，未坐下为 null */
  readonly you: Seat | null;
  readonly youAreHost: boolean;
}

/** 首页显示的服务器房间概览 */
export interface RoomSummary {
  readonly code: string;
  readonly game: GameKind;
  readonly players: 3 | 4 | 5 | 6;
  readonly started: boolean;
  readonly round: number;
  readonly phase: string | null;
  /** 升级的可选规则；斗地主为 null */
  readonly rules: RoomRules | null;
  readonly humans: number;
  readonly humansOnline: number;
  readonly bots: number;
  readonly names: readonly string[];
  readonly hostName: string;
  /** 有空位或机器人座位可以进 */
  readonly joinable: boolean;
  /** 在线观看的人数 */
  readonly spectators: number;
  /** 请求者能否关闭：只有房主能关 */
  readonly canClose: boolean;
  readonly lastActivity: number;
}

export type ServerMessage =
  /** 连上、登录、注册后都发：token 是这台设备之后用的会话，account 为 null 是游客 */
  | { readonly t: 'welcome'; readonly token: string; readonly name: string; readonly account: AccountInfo | null }
  /** 改了显示名字或头像 */
  | { readonly t: 'account'; readonly account: AccountInfo }
  /** 一般提示，比如「密码改好了」 */
  | { readonly t: 'notice'; readonly message: string }
  /** 退出登录了：这台设备回到首页，重新填名字当游客 */
  | { readonly t: 'loggedOut' }
  | { readonly t: 'adminAccounts'; readonly accounts: readonly AdminAccountRow[] }
  /** 管理员重置密码后给的临时密码，只发给管理员这一次 */
  | { readonly t: 'adminTempPassword'; readonly username: string; readonly password: string }
  | { readonly t: 'room'; readonly room: RoomInfo | null }
  /** declareLeftMs：发完牌后亮主思考时间还剩多少毫秒；declarePassed：点了「不反」的座位。都只在 declaring 阶段有；chaodiLeftMs：四人抄底轮到真人时还剩多少毫秒；guoheLeftMs：四人过河还有真人没决定时还剩多少毫秒；zaofanLeftMs、zaofanPassed：机器人庄家埋底前等真人造反还剩多少毫秒、谁点了「不造反」 */
  | { readonly t: 'state'; readonly seq: number; readonly view: PlayerView; readonly events: readonly GameEvent[]; readonly declareLeftMs?: number; readonly declarePassed?: readonly Seat[]; readonly chaodiLeftMs?: number; readonly guoheLeftMs?: number; readonly zaofanLeftMs?: number; readonly zaofanPassed?: readonly Seat[] }
  /** 斗地主房间的牌局 */
  | { readonly t: 'ddzState'; readonly seq: number; readonly view: DdzView; readonly events: readonly DdzEvent[] }
  | { readonly t: 'error'; readonly code: string; readonly message: string }
  | { readonly t: 'replay'; readonly replay: RoundReplay }
  | { readonly t: 'rooms'; readonly rooms: readonly RoomSummary[] }
  | { readonly t: 'pong' };

/** GET /api/server-info：lan 是局域网版里别人能用的访问地址（可能有几个网卡），线上为 null */
export interface ServerInfo {
  readonly lan: readonly string[] | null;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const r = clientMessageSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
