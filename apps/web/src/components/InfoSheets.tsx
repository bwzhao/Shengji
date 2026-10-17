import { cardPoints, sortCardsDesc, suitName, type Card, type PlayerView, type Seat } from '@shengji/engine';
import { CardRow } from './CardView.tsx';

const KIND_TEXT = { declare: '亮主', reinforce: '加固', override: '反主' } as const;

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="overlay info-sheet" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-title">{title}</div>
          <button className="ghost small" onClick={onClose}>关闭</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 本局亮主、加固、反主、翻底定主的全部记录，按先后排 */
export function DeclarationLogSheet({ view, name, onClose }: { view: PlayerView; name: (s: Seat) => string; onClose: () => void }) {
  const log = view.declarationLog;
  return (
    <Sheet title="亮主记录" onClose={onClose}>
      {log.length === 0 ? (
        <div className="hint">{view.trumpDecided ? '本局没有亮主记录' : '还没有人亮主'}</div>
      ) : (
        <ol className="decl-log">
          {log.map((e, i) => (
            <li key={i}>
              {e.kind === 'bottom' ? (
                <>
                  <span className="dl-who">无人亮主</span>
                  <span className="dl-kind">翻底</span>
                  {e.card && <CardRow cards={[e.card]} small />}
                  <span className="dl-suit">定{suitName(e.suit)}</span>
                </>
              ) : (
                <>
                  <span className="dl-who">{name(e.seat)}</span>
                  <span className={`dl-kind ${e.kind}`}>{KIND_TEXT[e.kind]}</span>
                  <CardRow cards={e.cards} small />
                  <span className="dl-suit">{suitName(e.suit)}</span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {view.trumpDecided && <div className="hint">本局主：{suitName(view.trumpSuit)}{view.dealer !== null ? `，庄家 ${name(view.dealer)}` : ''}</div>}
    </Sheet>
  );
}

/** 庄家看自己扣下的底牌 */
export function BottomSheet({ view, cards, onClose }: { view: PlayerView; cards: readonly Card[]; onClose: () => void }) {
  const points = cards.reduce((sum, c) => sum + cardPoints(c), 0);
  return (
    <Sheet title="我扣的底" onClose={onClose}>
      <CardRow cards={sortCardsDesc(cards, { level: view.level, trumpSuit: view.trumpSuit })} />
      <div className="hint">{cards.length} 张，{points} 分。只有你能看到，结算时公开。</div>
    </Sheet>
  );
}
