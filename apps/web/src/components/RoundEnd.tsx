import { levelRank, rankName, sortCardsDesc, type PlayerView } from '@shengji/engine';
import type { RoomInfo } from '@shengji/protocol';
import { CardRow } from './CardView.tsx';

export function RoundEnd({ view, room, onNext, onReplay, onLeave, onLobby }: {
  view: PlayerView; room: RoomInfo; onNext: () => void; onReplay: () => void;
  /** 退出房间 */
  onLeave: () => void;
  /** 房主：回大厅，座位保留，等级归零，可以再开一局 */
  onLobby: () => void;
}) {
  const r = view.lastRound!;
  const name = (seat: number) => room.seats[seat]?.name ?? `${seat + 1} 号`;
  const gameOver = view.phase === 'gameOver';
  const winners = r.dealerHeld ? r.dealerTeam : r.opponents;
  const iWon = winners.includes(view.seat);
  // 实际升了几级：四人升级 5、10、K 必打且庄上过，到 A 为止，可能比按分数算的少
  const gainOf = (i: number) => (r.levelsAfter[i] ?? 0) - (r.levelsBefore[i] ?? 0);
  const w = winners.reduce((a, b) => (gainOf(b) > gainOf(a) ? b : a));
  const gained = gainOf(w);
  const reached = rankName(levelRank(r.levelsAfter[w] ?? 0, view.config));
  const side = r.dealerHeld ? '庄家阵营' : '闲家阵营';
  const levelText = r.levelsUp === 0 ? '，不升级'
    : gained >= r.levelsUp ? `，${side}升 ${r.levelsUp} 级`
    : gained > 0 ? `，${side}升到 ${reached}（${reached} 必打）`
    : `，${side}停在 ${reached}（要坐庄守住才能过）`;
  return (
    <div className="overlay">
      <div className="sheet">
        <div className="sheet-title">{gameOver ? '游戏结束' : `第 ${r.round} 局结算`}</div>
        <div className={`result-line ${iWon ? 'win' : ''}`}>
          {r.dealerHeld ? (r.opponentPoints === 0 ? '大光！闲家一分没得' : '庄家阵营守住了') : '闲家上台'}
          {!gameOver && levelText}
          {iWon ? '，你这边赢了' : ''}
        </div>
        <table className="result-table">
          <tbody>
            <tr><td>庄家阵营</td><td>{r.dealerTeam.map(name).join('、')}</td></tr>
            <tr><td>闲家</td><td>{r.opponents.map(name).join('、')}</td></tr>
            <tr><td>闲家抓分</td><td>{r.capturedByOpponents}</td></tr>
            <tr><td>抠底</td><td>{r.bottomBonus > 0 ? `${r.bottomPoints} × ${r.bottomMultiplier} = ${r.bottomBonus}` : '无'}</td></tr>
            {r.penaltyDelta !== 0 && <tr><td>甩牌罚分</td><td>{r.penaltyDelta > 0 ? '+' : ''}{r.penaltyDelta}</td></tr>}
            <tr><td><b>闲家总分</b></td><td><b>{r.opponentPoints}</b></td></tr>
          </tbody>
        </table>
        <div className="label">底牌</div>
        <CardRow cards={sortCardsDesc(r.bottomCards, { level: view.level, trumpSuit: view.trumpSuit })} small />
        <div className="label">各人等级与抓分</div>
        <div className="levels">
          {r.levelsAfter.map((l, i) => {
            const before = r.levelsBefore[i] ?? l;
            const up = before !== l;
            const team = r.dealerTeam.includes(i) ? (i === r.dealer ? '庄' : '友') : '闲';
            return (
              <div key={i} className={`lv-row ${up ? 'up' : ''}`}>
                <span className={`role ${i === r.dealer ? 'dealer' : r.dealerTeam.includes(i) ? 'friend' : 'opp'}`}>{team}</span>
                <span>{name(i)}</span>
                <span className="pts">{view.captured[i] ?? 0} 分</span>
                <span className="lv">{up ? <>{rankName(levelRank(before, view.config))}<span className="arrow">→</span>{rankName(levelRank(l, view.config))}</> : rankName(levelRank(l, view.config))}</span>
              </div>
            );
          })}
        </div>
        {gameOver ? (
          <div className="result-line win">胜者：{view.winners?.map(name).join('、')}</div>
        ) : (
          <div className="hint">下一局庄家：{name(r.nextDealer)}</div>
        )}
        <div className="sheet-actions">
          <button className="ghost" onClick={onReplay}>回放本局</button>
          {gameOver ? (
            <>
              <button className="ghost danger" onClick={onLeave}>退出</button>
              {room.youAreHost ? <button className="primary" onClick={onLobby}>回到大厅</button> : <div className="hint">等房主回到大厅再开一局，或直接退出</div>}
            </>
          ) : (
            <>
              <button
                className="ghost danger"
                onClick={() => {
                  if (confirm(`退出本局？你的座位由机器人接管${room.youAreHost ? '，房主交给下一位真人' : ''}。之后用房间码 ${room.code} 重新进入可以接回机器人的座位。`)) onLeave();
                }}
              >退出本局</button>
              {room.youAreHost ? <button className="primary" onClick={onNext}>下一局</button> : <div className="hint">等待房主开始下一局</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
