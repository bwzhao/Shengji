import type { RoomRules } from '@shengji/protocol';

/** 四人升级的可选规则：开房时选，大厅里房主开局前还能改 */
export function RulesPicker({ rules, onChange, disabled = false }: { rules: RoomRules; onChange: (k: keyof RoomRules, v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="rules">
      <div className="rule-row">
        <span className="rule-name">抄底</span>
        <div className="seg">
          <button className={rules.chaodi ? 'on' : ''} disabled={disabled} onClick={() => onChange('chaodi', true)}>可以抄底</button>
          <button className={rules.chaodi ? '' : 'on'} disabled={disabled} onClick={() => onChange('chaodi', false)}>不抄底</button>
        </div>
      </div>
      <div className="rule-row">
        <span className="rule-name">过河</span>
        <div className="seg">
          <button className={rules.guohe ? 'on' : ''} disabled={disabled} onClick={() => onChange('guohe', true)}>可以过河</button>
          <button className={rules.guohe ? '' : 'on'} disabled={disabled} onClick={() => onChange('guohe', false)}>不过河</button>
        </div>
      </div>
      <div className="hint">抄底：庄家埋完底后，其他人可以用一对级牌或一对王拿起底牌重新埋。过河：主牌不多于 5 张的人可以把主牌给对家，换回副牌。</div>
    </div>
  );
}
