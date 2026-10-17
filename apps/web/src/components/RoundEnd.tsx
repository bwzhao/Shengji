import { levelRank, rankName, sortCardsDesc, type PlayerView } from '@shengji/engine';
import type { RoomInfo } from '@shengji/protocol';
import { Modal } from './Modal.tsx';
import { CardRow } from './CardView.tsx';

export function RoundEnd({ view, room, connected = true, onNext, onReplay, onLeave, onLobby }: {
  view: PlayerView; room: RoomInfo; connected?: boolean; onNext: () => void; onReplay: () => void;
  /** 退出房间 */
  onLeave: () => void;
  /** 房主：回大厅，座位保留，等级归零，可以再开一局 */
  onLobby: () => void;
}) {
  const r = view.lastRound!;
  const name = (seat: number) => room.seats[seat]?.name ?? `${seat + 1} 号`;
  const gameOver = view.phase === 'gameOver';
  const iWon = (r.dealerHeld ? r.dealerTeam : r.opponents).includes(view.seat);
  return (
    <Modal title={gameOver ? '游戏结束' : `第 ${r.round} 局结算`}>
        <div className={`result-line ${iWon ? 'win' : ''}`}>
          {r.dealerHeld ? (r.opponentPoints === 0 ? '大光！闲家一分没得' : '庄家阵营守住了') : '闲家上台'}
          {!gameOver && (r.levelsUp > 0 ? `，${r.dealerHeld ? '庄家阵营' : '闲家阵营'}升 ${r.levelsUp} 级` : '，不升级')}
          {iWon ? '，你这边赢了' : ''}
        </div>
        <table className="result-table">
          <tbody>
            <tr><td>庄家阵营</td><td>{r.dealerTeam.map(name).join('、')}</td></tr>
            <tr><td>闲家</td><td>{r.opponents.map(name).join('、')}</td></tr>
            <tr><td>闲家抓分</td><td>{r.capturedByOpponents}</td></tr>
            <tr><td>抠底</td><td>{r.bottomBonus > 0 ? `${r.bottomPoints} × ${r.bottomMultiplier} = ${r.bottomBonus}` : '无'}</td></tr>
            {(r.penaltyDelta !== 0 || (r.round === view.round && view.penalties.some(p => p > 0))) && <tr><td>甩牌罚分</td><td>{r.penaltyDelta > 0 ? '+' : ''}{r.penaltyDelta}</td></tr>}
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
          <button className="ghost" disabled={!connected} onClick={onReplay}>回放本局</button>
          {gameOver ? (
            <>
              <button className="ghost danger" onClick={onLeave}>退出</button>
              {room.youAreHost ? <button className="primary" disabled={!connected} onClick={onLobby}>回到大厅</button> : <div className="hint">等房主回到大厅再开一局，或直接退出</div>}
            </>
          ) : (
            <>
              <button
                className="ghost danger"
                onClick={() => {
                  if (confirm(`退出本局？你的座位由机器人接管${room.youAreHost ? '，房主交给下一位真人' : ''}。之后用房间码 ${room.code} 重新进入可以接回机器人的座位。`)) onLeave();
                }}
              >退出本局</button>
              {room.youAreHost ? <button className="primary" disabled={!connected} onClick={onNext}>下一局</button> : <div className="hint">等待房主开始下一局</div>}
            </>
          )}
        </div>
    </Modal>
  );
}
