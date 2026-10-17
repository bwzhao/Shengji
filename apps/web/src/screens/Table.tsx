import { useEffect, useMemo, useRef, useState } from 'react';
import {
  checkDeclaration, createRng, declarationCandidates, decompose, generateFollow, groupOf, identityKey, levelRank, rankName, sortCardsDesc, suitName, summarizePointCards, trickWinner, validateFollow,
  type Card, type GameEvent, type PlayerView, type Seat, type TrickPlay,
} from '@shengji/engine';
import type { ClientMessage } from '@shengji/protocol';
import { CardRow, CardView } from '../components/CardView.tsx';
import { FriendCallForm } from '../components/FriendCallForm.tsx';
import { BottomSheet, DeclarationLogSheet } from '../components/InfoSheets.tsx';
import { RoundEnd } from '../components/RoundEnd.tsx';
import { Avatar } from '../avatar.tsx';
import { sound } from '../sound.ts';
import type { GameClient } from '../ws.ts';

const GLYPH: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const CN_NTH = ['一', '二', '三'];

interface Pos { x: number; y: number }
/** 对手座位在牌桌上的位置（百分比）。牌桌只按横屏设计：出牌逆时针，下家在我的右手边，依次绕到左手边 */
const SEAT_POS: Record<number, Pos[]> = {
  3: [{ x: 89, y: 50 }, { x: 50, y: 11 }, { x: 11, y: 50 }],
  4: [{ x: 89, y: 60 }, { x: 67, y: 12 }, { x: 33, y: 12 }, { x: 11, y: 60 }],
  5: [{ x: 90, y: 64 }, { x: 73, y: 12 }, { x: 50, y: 10 }, { x: 27, y: 12 }, { x: 10, y: 64 }],
};
const ME_POS: Pos = { x: 50, y: 104 };

/**
 * 每个座位出牌的落点和最大宽度（牌桌宽度的百分比）。按人数固定排好，保证所有人同时出拖拉机、甩牌时互不压住：
 * 顶上一排在各自座位正下方，两侧的牌放在座位内侧；五六人时两侧的牌再往下放，避开顶上一排。
 * 牌多时缩小牌间距，整排不超过最大宽度。手机横屏 667×375 与 844×390 实测见设计文档 3.5。
 */
interface PlaySlot extends Pos { readonly maxW: number }
const PLAY_POS: Record<number, PlaySlot[]> = {
  3: [{ x: 69.5, y: 50, maxW: 19 }, { x: 50, y: 43, maxW: 19 }, { x: 30.5, y: 50, maxW: 19 }],
  4: [{ x: 70.5, y: 76.5, maxW: 20 }, { x: 67, y: 44, maxW: 26 }, { x: 33, y: 44, maxW: 26 }, { x: 29.5, y: 76.5, maxW: 20 }],
  5: [{ x: 70.5, y: 76.5, maxW: 20 }, { x: 71.5, y: 44, maxW: 21 }, { x: 50, y: 44, maxW: 21 }, { x: 28.5, y: 44, maxW: 21 }, { x: 29.5, y: 76.5, maxW: 20 }],
};
const ME_PLAY: PlaySlot = { x: 50, y: 83, maxW: 19 };

/** 桌上一排牌最少露出的宽度（px），和 styles.css 里的 14px 一致 */
const MIN_CARD_STEP = 14;
const CENTER: Pos = { x: 50, y: 56 };
const towardCenter = (p: Pos, t: number): Pos => ({ x: p.x + (CENTER.x - p.x) * t, y: p.y + (CENTER.y - p.y) * t });

/** 分牌汇总的显示文字，例如 ♠K×2 */
function pointSummary(cards: readonly Card[], trumpSuit: PlayerView['trumpSuit']): { key: string; label: string; red: boolean }[] {
  return summarizePointCards(cards, trumpSuit).map(({ suit, rank, count }) => ({
    key: `${suit}${rank}`,
    label: `${GLYPH[suit]}${rankName(rank)}${count > 1 ? `×${count}` : ''}`,
    red: suit === 'H' || suit === 'D',
  }));
}

/**
 * 牌间距压到最小仍超出该座位最大宽度时的缩放比例。maxW 是牌桌宽度的百分比（cqw），vp.w 是牌桌宽度；
 * 牌宽与 styles.css 一致：屏幕高 600 以上 60px，否则 48px
 */
function playScale(n: number, maxW: number, vp: { w: number; h: number; feltH: number }): number {
  const cardW = vp.h >= 600 ? 60 : 48;
  const cardH = vp.h >= 600 ? 84 : 67;
  // 高度：出牌落点按「牌高约占牌桌高 32%」排；牌桌更矮时（上面多了朋友牌、分牌一行）整体按比例缩小。
  // 座位牌是固定像素高（约 52px），顶上一排出牌（中心在 44%）不能碰到顶上座位牌（中心约 12%）的下沿
  const H = vp.feltH;
  const byHeight = Math.min((0.32 * H) / cardH, (0.32 * H - 26) / (cardH / 2));
  const byWidth = n <= 1 ? 1 : ((maxW * vp.w) / 100) / (cardW + MIN_CARD_STEP * (n - 1));
  return Math.min(1, Math.max(0.6, Math.min(byWidth, byHeight)));
}

function roleOf(view: PlayerView, seat: Seat): { text: string; cls: string } {
  if (view.dealer === seat) return { text: '庄', cls: 'dealer' };
  if (view.dealerTeam.includes(seat)) return { text: '友', cls: 'friend' };
  if (view.knownOpponents.includes(seat)) return { text: '闲', cls: 'opp' };
  return { text: '?', cls: 'unknown' };
}

function declarable(view: PlayerView, selected: readonly Card[]): boolean {
  if (view.phase !== 'dealing' && view.phase !== 'declaring') return false;
  return checkDeclaration(view, view.seat, selected) === null;
}

interface DeclareOption { cards: Card[]; label: string }

/** 一键亮主的选项：和服务端、机器人用同一份规则（engine 的 checkDeclaration） */
function declarationOptions(view: PlayerView): DeclareOption[] {
  if (view.phase !== 'dealing' && view.phase !== 'declaring') return [];
  return declarationCandidates(view.hand, view, view.seat).map((cards) => {
    const first = cards[0] as Card;
    const mixed = cards.length === 3 && cards.every((c) => c.suit === 'J') && !cards.every((c) => c.rank === first.rank);
    const name = first.suit === 'J' ? (first.rank === 16 ? '大王' : '小王') : `${GLYPH[first.suit]}${rankName(first.rank)}`;
    const label = mixed ? '亮 三张王' : cards.length === 1 ? `亮 ${name}` : `亮 ${name} × ${cards.length}`;
    const mine = view.declaration?.seat === view.seat;
    return { cards, label: mine ? label.replace('亮', '加固') : label };
  });
}

function statusText(view: PlayerView, name: (s: Seat) => string): string {
  const me = view.seat;
  switch (view.phase) {
    case 'dealing': return view.declaration ? `${name(view.declaration.seat)} 亮了 ${view.declaration.count} 张，更多张可以反` : '发牌中，有级牌或对王可以亮主';
    case 'declaring': {
      // 反主只改主花色，不改庄家：只有首局才是先亮主者坐庄
      const dealerText = view.dealer !== null ? `，${name(view.dealer)} 坐庄` : '';
      return view.declaration ? `${name(view.declaration.seat)} 亮 ${suitName(view.trumpSuit)}为主${dealerText}` : '无人亮主，即将翻底牌';
    }
    case 'bottom': return view.dealer === me ? '你是庄家，选 ' + view.config.bottomSize + ' 张扣底' : `${name(view.dealer!)} 正在扣底`;
    case 'callFriend': return view.dealer === me ? '叫朋友' : `${name(view.dealer!)} 正在叫朋友`;
    case 'playing': return view.currentTurn === me ? (view.trick?.plays.length ? '轮到你跟牌' : '轮到你出牌') : `等 ${name(view.currentTurn!)} 出牌`;
    case 'roundEnd': return '本局结束';
    case 'gameOver': return '游戏结束';
  }
}

/** 手牌分成两排：尽量在花色边界处切开，让同一花色不跨排。牌少于 8 张时只用一排。 */
function splitHand(hand: readonly Card[], ctx: { level: number; trumpSuit: PlayerView['trumpSuit'] }, rows: 1 | 2): Card[][] {
  if (rows === 1 || hand.length < 8) return [[...hand]];
  const mid = hand.length / 2;
  let best = Math.ceil(mid);
  let bestDist = Infinity;
  for (let i = 1; i < hand.length; i++) {
    const a = hand[i - 1] as Card, b = hand[i] as Card;
    if (groupOf(a, ctx) === groupOf(b, ctx)) continue;
    const dist = Math.abs(i - mid);
    if (dist < bestDist && dist <= hand.length * 0.2) { bestDist = dist; best = i; }
  }
  return [hand.slice(0, best), hand.slice(best)];
}

export function Table({ client }: { client: GameClient }) {
  const view = client.view!;
  const room = client.room!;
  const me = view.seat;
  const n = view.config.players;
  const [selected, setSelected] = useState<string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [linger, setLinger] = useState<{ trick: typeof view.lastTrick; until: number } | null>(null);
  // 「上一轮」按钮：点一下把上一墩每人出的牌摆回桌上看 3 秒，再点一下提前收起
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const togglePeek = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    if (peek) { peekTimer.current = null; setPeek(false); return; }
    setPeek(true);
    peekTimer.current = setTimeout(() => { peekTimer.current = null; setPeek(false); }, 3000);
  };
  useEffect(() => () => { if (peekTimer.current) clearTimeout(peekTimer.current); }, []);
  const [soundOn, setSoundOn] = useState(sound.enabled);
  const [menuOpen, setMenuOpen] = useState(false);
  // 顶栏「主」打开亮主记录，庄家点「底」看自己扣的底
  const [sheet, setSheet] = useState<'declarations' | 'bottom' | null>(null);
  // 牌桌宽度与窗口高度：出牌太长、牌间距压到最小仍放不下时整排缩小，需要知道牌桌多宽、牌有多宽
  const feltRef = useRef<HTMLElement | null>(null);
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight, feltH: 210 }));
  useEffect(() => {
    const update = () => setViewport({ w: feltRef.current?.clientWidth ?? window.innerWidth, h: window.innerHeight, feltH: feltRef.current?.clientHeight ?? 210 });
    update();
    const ro = typeof ResizeObserver !== 'undefined' && feltRef.current ? new ResizeObserver(update) : null;
    if (ro && feltRef.current) ro.observe(feltRef.current);
    window.addEventListener('resize', update);
    return () => { ro?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const prevHandIds = useRef<Set<string>>(new Set());
  const prevTurn = useRef<boolean>(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const name = (s: Seat) => room.seats[s]?.name ?? `${s + 1} 号`;

  const positions = useMemo(() => {
    const opps: Seat[] = [];
    for (let k = 1; k < n; k++) opps.push((me + k) % n);
    const map = new Map<Seat, Pos>();
    const plays = new Map<Seat, PlaySlot>();
    const list = SEAT_POS[n - 1] ?? SEAT_POS[5]!;
    const playList = PLAY_POS[n - 1] ?? PLAY_POS[5]!;
    opps.forEach((s, i) => { map.set(s, list[i] as Pos); plays.set(s, playList[i] as PlaySlot); });
    map.set(me, ME_POS);
    plays.set(me, ME_PLAY);
    return { opps, map, plays };
  }, [me, n]);
  const posOf = (s: Seat): Pos => positions.map.get(s) ?? CENTER;
  const playPosOf = (s: Seat): PlaySlot => positions.plays.get(s) ?? { ...towardCenter(posOf(s), 0.6), maxW: 20 };

  // 手牌变化：清理失效选择，标记新发到的牌
  const newIds = useMemo(() => {
    const ids = new Set(view.hand.map((c) => c.id));
    const fresh = new Set<string>();
    for (const id of ids) if (!prevHandIds.current.has(id)) fresh.add(id);
    prevHandIds.current = ids;
    return fresh;
  }, [view.hand]);
  useEffect(() => {
    setSelected((sel) => sel.filter((id) => view.hand.some((c) => c.id === id)));
  }, [view.hand]);

  // 事件：闪现文字 + 音效
  useEffect(() => {
    const texts: string[] = [];
    for (const e of client.events as GameEvent[]) {
      switch (e.type) {
        case 'cardsPlayed': if (e.seat !== me) sound.tick(); break;
        case 'cardDealt': if (e.seat === me) sound.tick(); break;
        case 'trickWon': {
          texts.push(`${name(e.winner)} 收了这墩${e.points ? `，${e.points} 分` : ''}`);
          // 已确认的闲家拿到分：鼓掌
          if (e.points > 0 && view.knownOpponents.includes(e.winner)) sound.applause();
          else sound.win();
          break;
        }
        case 'friendRevealed': texts.push(e.seat === view.dealer ? '庄家自己打出了朋友牌' : `${name(e.seat)} 是庄家的朋友`); sound.friend(); break;
        case 'throwFailed': texts.push(`${name(e.seat)} 甩牌失败，罚 ${e.penalty} 分`); sound.error(); break;
        case 'declared': texts.push(`${name(e.seat)} 亮 ${e.count} 张${e.suit ? GLYPH[e.suit] : '王'}`); sound.bark(); break;
        case 'declaringClosed': if (e.byBottom) texts.push(`无人亮主，翻底牌定${suitName(e.trumpSuit)}`); break;
        case 'redeal': texts.push('无人亮主，重新发牌'); break;
        case 'roundRestarted': texts.push('房主重发了本局'); break;
        default: break;
      }
    }
    if (texts.length) {
      setFlash(texts.join('；'));
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => { flashTimer.current = null; setFlash(null); }, 2200);
    }
  }, [client.events]);

  // 服务端每次都发整份视图，lastTrick 每次都是新对象；用牌的内容当键，只在真的有新一墩结束时触发
  const lastTrickKey = view.lastTrick ? `${view.round}:${view.lastTrick.plays.map((p) => p.cards.map((c) => c.id).join(',')).join('|')}` : '';
  // 上一墩短暂停留并飞向赢家；新的一墩结束时收起「上一轮」
  useEffect(() => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
    setPeek(false);
    if (view.lastTrick && (view.trick?.plays.length ?? 0) === 0) {
      setLinger({ trick: view.lastTrick, until: Date.now() + 1100 });
      const t = setTimeout(() => setLinger(null), 1100);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTrickKey]);

  const myTurn = view.phase === 'playing' && view.currentTurn === me;
  useEffect(() => {
    if (myTurn && !prevTurn.current) sound.turn();
    prevTurn.current = myTurn;
  }, [myTurn]);

  // 自动提示亮主：新出现能亮的组合时响一声，牌面高亮
  const declareOpts = useMemo(() => declarationOptions(view), [view.hand, view.phase, view.level, view.declaration]);
  const declarableIds = useMemo(() => new Set(declareOpts.flatMap((o) => o.cards.map((c) => c.id))), [declareOpts]);
  const prevDeclareKey = useRef('');
  useEffect(() => {
    const key = declareOpts.map((o) => o.label).join('|');
    if (key && key !== prevDeclareKey.current) sound.turn();
    prevDeclareKey.current = key;
  }, [declareOpts]);

  const selectedCards = useMemo(() => view.hand.filter((c) => selected.includes(c.id)), [view.hand, selected]);
  const toggle = (id: string) => { sound.unlock(); setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])); };
  const send = (m: ClientMessage) => client.send(m);
  const ctx = { level: view.level, trumpSuit: view.trumpSuit };
  // 手牌从大到小、从左到右：view.hand 是从小到大排好的，倒过来显示
  const handRows = useMemo(() => splitHand([...view.hand].reverse(), ctx, 1), [view.hand, view.level, view.trumpSuit]);

  // 跟牌辅助：即时校验 + 灰显不该出的牌
  const lead = view.trick?.lead ?? null;
  const following = Boolean(lead && (view.trick?.plays.length ?? 0) > 0);
  let leadCount = 0;
  if (lead) for (const c of lead.components) leadCount += c.cards.length;
  const myGroupCount = lead ? view.hand.filter((c) => groupOf(c, ctx) === lead.group).length : 0;
  const dimCard = (c: Card) => following && lead !== null && myGroupCount >= leadCount && groupOf(c, ctx) !== lead.group;
  let playHint: string | null = null;
  let canPlay = myTurn && selected.length > 0;
  if (myTurn && following && lead) {
    if (selected.length !== leadCount) { playHint = selected.length ? `要出 ${leadCount} 张` : null; canPlay = false; }
    else {
      const err = validateFollow(lead, view.hand, selectedCards, ctx);
      if (err) { playHint = err.message; canPlay = false; }
    }
  } else if (myTurn && selected.length > 0) {
    const d = decompose(selectedCards, ctx);
    if (!d) { playHint = '首出必须同一花色，或者全是主牌'; canPlay = false; }
    else if (d.components.length > 1) playHint = '甩牌：有人压得住就要罚分';
  }

  const hint = () => {
    const rng = createRng(String(Date.now()));
    let cards: Card[];
    if (lead && following) cards = generateFollow(lead, view.hand, ctx, rng);
    else {
      const groups = new Map<string, Card[]>();
      for (const c of view.hand) groups.set(groupOf(c, ctx), [...(groups.get(groupOf(c, ctx)) ?? []), c]);
      const biggest = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      const d = decompose(biggest, ctx);
      const comp = d?.components[d.components.length - 1];
      cards = comp ? [...comp.cards] : view.hand.slice(0, 1);
    }
    setSelected(cards.map((c) => c.id));
  };

  const friendText = view.friendCalls.map((c) => {
    const who = c.resolvedSeat === null ? '未现身' : c.resolvedSeat === view.dealer ? '庄家自占' : name(c.resolvedSeat);
    return `第${CN_NTH[c.nth - 1]}张 ${GLYPH[c.suit]}${rankName(c.rank)} · ${who}`;
  });

  // 当前要显示的出牌：「上一轮」查看中的上一墩，进行中的墩，或停留中的上一墩
  const currentPlays: readonly TrickPlay[] = view.trick?.plays ?? [];
  const peeking = peek && view.lastTrick ? view.lastTrick : null;
  const lingering = !peeking && currentPlays.length === 0 && linger && linger.trick ? linger.trick : null;
  const shownPlays: readonly TrickPlay[] = peeking ? peeking.plays : lingering ? lingering.plays : currentPlays;
  const winnerPos = lingering ? posOf(lingering.winner) : null;
  const canPeek = view.phase === 'playing' && view.lastTrick !== null;
  // 桌上正在显示的那一墩目前谁最大：查看上一轮或上一墩收走时就是赢家；进行中的墩用引擎的 trickWinner 实时算
  const shownWinner: Seat | null = (() => {
    if (peeking) return peeking.winner;
    if (lingering) return lingering.winner;
    const lead = view.trick?.lead;
    if (!lead || currentPlays.length === 0) return null;
    const idx = trickWinner(currentPlays, lead, { level: view.level, trumpSuit: view.trumpSuit });
    return currentPlays[idx]?.seat ?? null;
  })();
  // 「首」标在桌上正在显示的那一墩的首家：查看上一轮时是上一墩的首家，否则是当前这一墩的
  const shownLeader: Seat | null = peeking ? peeking.leader : currentPlays.length > 0 ? (view.trick?.leader ?? null) : null;

  // 扣完底之后、结算之前，庄家可以随时看自己扣的底
  const myBottom = view.dealer === me && (view.phase === 'callFriend' || view.phase === 'playing') && view.bottom?.length ? view.bottom : null;

  const pct = (p: Pos): React.CSSProperties => ({ left: `${p.x}%`, top: `${p.y}%` });

  return (
    <div className="table">
      <div className="rotate-cover"><div className="rotate-icon">⟲</div><div>请把手机横过来</div><div className="hint">牌桌按横屏设计</div></div>
      <header className="topbar">
        <span className="tb-item tb-code" title="房间码">房 <b>{room.code}</b></span>
        <span className="tb-item">第 {view.round} 局</span>
        <span className="tb-item">级 <b>{rankName(view.level)}</b></span>
        <button className="tb-item tb-click" onClick={() => setSheet('declarations')} title="亮主记录">
          主 <b className={view.trumpSuit === 'H' || view.trumpSuit === 'D' ? 'red' : ''}>{view.trumpDecided ? suitName(view.trumpSuit) : '未定'}</b>
          {view.declarationLog.length > 0 && <span className="tb-count">{view.declarationLog.length}</span>}
          <span className="tb-caret">▾</span>
        </button>
        <span className="tb-item">闲家 <b>{view.visibleOpponentPoints}</b>{view.pendingPoints > 0 && <span className="pending"> 待定 {view.pendingPoints}</span>}</span>
        {myBottom ? (
          <button className="tb-item tb-click" onClick={() => setSheet('bottom')} title="看我扣的底">底 {view.bottomCount}<span className="tb-caret">▾</span></button>
        ) : (
          <span className="tb-item">底 {view.bottomCount}{view.phase === 'dealing' ? ` · 剩 ${view.deckRemaining}` : ''}</span>
        )}
        <button className="tb-btn" onClick={() => setSoundOn(sound.toggle())} aria-label="音效">{soundOn ? '🔊' : '🔇'}</button>
        <button className={`tb-menu ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen((v) => !v)} aria-label="菜单" aria-expanded={menuOpen}>⋯ 菜单</button>
      </header>
      {menuOpen && (
        <div className="host-menu">
          {room.youAreHost && (
            <>
              <button className="ghost small" onClick={() => {
                setMenuOpen(false);
                if (confirm('重发本局？当前进度作废，等级和庄家保留。')) send({ t: 'restartRound' });
              }}>重发本局</button>
              <button className="ghost small danger" onClick={() => {
                setMenuOpen(false);
                if (confirm('结束游戏回到大厅？所有人等级归零，座位保留。')) send({ t: 'abortGame' });
              }}>结束游戏</button>
              <button className="ghost small danger" onClick={() => {
                setMenuOpen(false);
                if (confirm(`关闭房间 ${room.code}？牌局删除，所有人回到首页。`)) send({ t: 'closeRoom' });
              }}>关闭房间</button>
            </>
          )}
          <button className="ghost small danger" onClick={() => {
            setMenuOpen(false);
            if (confirm(`退出本局？你的座位由机器人接管${room.youAreHost ? '，房主交给下一位真人' : ''}。之后用房间码 ${room.code} 重新进入可以接回机器人的座位。`)) send({ t: 'leaveRoom' });
          }}>退出本局</button>
          <button className="ghost small" onClick={() => setMenuOpen(false)}>取消</button>
        </div>
      )}
      {/* 朋友牌和闲家分牌合成一行、分牌用小号牌，少占牌桌的高度 */}
      {(view.friendCalls.length > 0 || view.opponentPointCards.length > 0 || view.pendingPointCards.length > 0) && (
        <div className="info-line">
          {view.friendCalls.length > 0 && <span className="friends-line">朋友牌：{friendText.join('　')}</span>}
          {(view.opponentPointCards.length > 0 || view.pendingPointCards.length > 0) && (
            <span className="points-line">
              <span className="points-label">闲家分牌</span>
              {pointSummary(view.opponentPointCards, view.trumpSuit).map((p) => <span key={p.key} className={`pt ${p.red ? 'red' : ''}`}>{p.label}</span>)}
              {view.pendingPointCards.length > 0 && (
                <span className="pt-pending">
                  待定{pointSummary(view.pendingPointCards, view.trumpSuit).map((p) => <span key={p.key} className={`pt ${p.red ? 'red' : ''}`}>{p.label}</span>)}
                </span>
              )}
            </span>
          )}
        </div>
      )}

      <section className="felt" ref={feltRef}>
        <div className="felt-ring" />
        {positions.opps.map((seat) => {
          const role = roleOf(view, seat);
          const s = room.seats[seat];
          const isTurn = view.currentTurn === seat;
          return (
            <div key={seat} data-seat={seat} className={`badge ${isTurn ? 'turn' : ''} ${role.cls}`} style={pct(posOf(seat))}>
              <span className="b-avatar"><Avatar name={name(seat)} isBot={Boolean(s?.isBot)} size={40} /><span className={`role role-dot ${role.cls}`}>{role.text}</span></span>
              <span className="b-name">{name(seat)}</span>
              <span className="b-meta">
                <span className="b-level">{rankName(levelRank(view.levels[seat] ?? 0, view.config))}</span>
                <span className="b-count">{view.handCounts[seat]}</span>
                {shownLeader === seat && <span className="b-lead" title="这一墩是他先出的">首</span>}
                {s && !s.connected && <span className="b-off">离线</span>}
              </span>
            </div>
          );
        })}

        {shownPlays.map((p) => {
          const from = posOf(p.seat), to = playPosOf(p.seat);
          const style: React.CSSProperties = {
            ...pct(to),
            ['--n' as string]: String(p.cards.length),
            ['--maxw' as string]: `${to.maxW}cqw`,
            ['--k' as string]: String(playScale(p.cards.length, to.maxW, viewport)),
            ['--fx' as string]: `${(from.x - to.x) * 0.9}vw`,
            ['--fy' as string]: `${(from.y - to.y) * 0.5}vh`,
            ['--cx' as string]: winnerPos ? `${(winnerPos.x - to.x) * 0.9}vw` : '0px',
            ['--cy' as string]: winnerPos ? `${(winnerPos.y - to.y) * 0.5}vh` : '0px',
          };
          return (
            <div
              key={`${p.seat}-${peeking ? 'p' : lingering ? 'l' : 'c'}`}
              data-seat={p.seat}
              className={`play ${lingering ? 'collect' : ''} ${peeking ? 'peek' : ''} ${shownWinner === p.seat ? 'won' : ''}`}
              style={style}
            >
              <CardRow cards={sortCardsDesc(p.cards, ctx)} small />
            </div>
          );
        })}

        {/* 桌上有牌时把提示挪到左上角，免得压住出的牌 */}
        <div className={`center-msg ${shownPlays.length > 0 && view.phase === 'playing' ? 'aside' : ''}`} style={pct(CENTER)}>
          <div className={`status ${flash ? 'flash' : ''} ${peeking ? 'peeking' : ''}`}>
            {peeking ? `上一轮：${name(peeking.winner)} 赢${peeking.points ? `，${peeking.points} 分` : ''}` : (flash ?? statusText(view, name))}
          </div>
          {view.declaration && (view.phase === 'dealing' || view.phase === 'declaring') && (
            <div className="declared"><span>{name(view.declaration.seat)} 亮</span><CardRow cards={view.declaration.cards} small /></div>
          )}
          {declareOpts.length > 0 && (
            <div className="declare-hints">
              {declareOpts.map((o) => (
                <button key={o.label} className="primary small declare-btn" onClick={() => { send({ t: 'declare', cards: o.cards.map((c) => c.id) }); setSelected([]); }}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {view.phase === 'callFriend' && view.dealer === me && <FriendCallForm view={view} send={send} />}
        </div>
      </section>

      <section className="me">
        <div className="me-head">
          <span className={`role ${roleOf(view, me).cls}`}>{roleOf(view, me).text}</span>
          <span className="b-name">{name(me)}</span>
          <span className="b-level">{rankName(levelRank(view.levels[me] ?? 0, view.config))}</span>
          <span className="b-count">{view.hand.length}</span>
          {shownLeader === me && <span className="b-lead" title="这一墩是你先出的">首</span>}
          {playHint && <span className="play-hint">{playHint}</span>}
          {selected.length > 0 && <button className="ghost tiny" onClick={() => setSelected([])}>清除</button>}
        </div>
        <div className="hand">
          {handRows.map((row, r) => (
            <div key={r} className="hand-row" style={{ ['--n' as string]: row.length } as React.CSSProperties}>
              {row.map((c) => (
                <CardView
                  key={c.id}
                  card={c}
                  selected={selected.includes(c.id)}
                  dim={dimCard(c)}
                  className={`${newIds.has(c.id) ? 'dealt' : ''} ${declarableIds.has(c.id) ? 'declarable' : ''}`}
                  onClick={() => toggle(c.id)}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="actions">
          {(view.phase === 'dealing' || view.phase === 'declaring') && (
            <button className="primary" disabled={!declarable(view, selectedCards)} onClick={() => { send({ t: 'declare', cards: selected }); setSelected([]); }}>
              亮主{selected.length ? ` ${selected.length} 张` : ''}
            </button>
          )}
          {view.phase === 'bottom' && view.dealer === me && (
            <button className="primary" disabled={selected.length !== view.config.bottomSize} onClick={() => { send({ t: 'exchangeBottom', cards: selected }); setSelected([]); }}>
              扣底 {selected.length}/{view.config.bottomSize}
            </button>
          )}
          {view.phase === 'playing' && (
            <>
              {/* 「上一轮」和「提示」并排一行，不增加操作区高度；还没打完第一墩时「上一轮」先灰着 */}
              <div className="action-row">
                <button className={`ghost peek-btn ${peeking ? 'on' : ''}`} disabled={!canPeek} onClick={togglePeek} aria-pressed={Boolean(peeking)}>
                  {peeking ? '收起' : '上一轮'}
                </button>
                <button className="ghost" disabled={!myTurn} onClick={hint}>提示</button>
              </div>
              <button className={`primary ${myTurn ? 'pulse' : ''}`} disabled={!canPlay} onClick={() => { send({ t: 'play', cards: selected }); setSelected([]); }}>
                出牌{selected.length ? ` ${selected.length} 张` : ''}
              </button>
            </>
          )}
        </div>
      </section>

      {sheet === 'declarations' && <DeclarationLogSheet view={view} name={name} onClose={() => setSheet(null)} />}
      {sheet === 'bottom' && myBottom && <BottomSheet view={view} cards={myBottom} onClose={() => setSheet(null)} />}

      {(view.phase === 'roundEnd' || view.phase === 'gameOver') && view.lastRound && (
        <RoundEnd
          view={view}
          room={room}
          onNext={() => send({ t: 'nextRound' })}
          onReplay={() => send({ t: 'getReplay', round: view.round })}
          onLeave={() => send({ t: 'leaveRoom' })}
          onLobby={() => send({ t: 'abortGame' })}
        />
      )}
    </div>
  );
}
