import { useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from './Modal.tsx';

export function PageChrome({ title, onBack, children }: { title: string; onBack?: () => void; children?: ReactNode }) {
  const [rules, setRules] = useState(false);
  return <>
    <div className="page-toolbar">
      <div className="toolbar-context">
        {onBack && <button className="ghost" onClick={onBack}>← 返回大厅</button>}
        <span className="page-title">{title}</span>
      </div>
      <div className="toolbar-actions">
        <button className="ghost" onClick={() => setRules(true)}>玩法规则</button>
        {children}
      </div>
    </div>
    {rules && <Modal title="玩法规则" onClose={() => setRules(false)}>
      <h3>4 人 · 固定对家</h3><p>两副牌，每人 25 张，底牌 8 张，对面的人就是队友。每 40 分一级，80 分下庄。从 2 打到 A，5、10、K 必打，在 A 上坐庄守住才赢。</p>
      <h3>5 / 6 人 · 找朋友</h3><p>三副牌，庄家扣底后指定朋友牌及出现次序。打出对应牌的玩家成为队友：5 人找 1 位，6 人找 2 位。5 人每 60 分一级、120 分下庄；6 人每 50 分一级、100 分下庄。</p>
      <h3>一局流程</h3><p>发牌亮主 → 庄家扣底 → 叫朋友（5 / 6 人）→ 逆时针出牌 → 结算升级。5、10、K 是分牌。有首出花色必须跟该花色，有对应对子或拖拉机时按规则跟牌。</p>
      <div className="sheet-actions"><button className="primary" onClick={() => setRules(false)}>知道了</button></div>
    </Modal>}
  </>;
}
