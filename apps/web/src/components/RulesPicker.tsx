import { useEffect, useState } from 'react';
import { defaultConfig } from '@shengji/engine';
import { zaofanRuleError, type RoomRules, type ZaofanRule } from '@shengji/protocol';

/** 这个人数默认的造反分数线 */
export function defaultZaofan(players: 4 | 5 | 6): ZaofanRule | null {
  return defaultConfig(players).zaofan ?? null;
}

const sameRule = (a: ZaofanRule, b: ZaofanRule | null) => Boolean(b) && a.low === b!.low && a.high === b!.high && a.dealerHigh === b!.dealerHigh;

/** 房间列表里只写和默认不一样的规则 */
export function rulesNote(rules: RoomRules | null, players: number): string {
  if (!rules || players < 4) return '';
  const notes: string[] = [];
  if (players === 4 && !rules.chaodi) notes.push('不抄底');
  if (players === 4 && !rules.guohe) notes.push('不过河');
  const z = rules.zaofan;
  if (!z) notes.push('不能造反');
  else if (!sameRule(z, defaultZaofan(players as 4 | 5 | 6))) notes.push(`造反 ${z.low}/${z.high}/${z.dealerHigh} 分`);
  return notes.length ? ` · ${notes.join('、')}` : '';
}

/** 分数输入框：打字时先存着，离开或回车时再交出去，打错了退回原来的数 */
function ScoreInput({ value, disabled, label, onCommit }: { value: number; disabled: boolean; label: string; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isInteger(n) || n < 0) return setDraft(String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      className="score" type="number" inputMode="numeric" min={0} max={300} step={5} aria-label={label}
      value={draft} disabled={disabled}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

/** 升级的可选规则：开房时选，大厅里房主开局前还能改。抄底、过河只有四人局有；造反各人数都有 */
export function RulesPicker({ players, rules, onChange, disabled = false }: {
  players: 4 | 5 | 6; rules: RoomRules; onChange: (patch: Partial<RoomRules>) => void; disabled?: boolean;
}) {
  const def = defaultZaofan(players);
  const z = rules.zaofan;
  const problem = z ? zaofanRuleError(z, players) : null;
  const setScore = (k: keyof ZaofanRule) => (n: number) => { if (z) onChange({ zaofan: { ...z, [k]: n } }); };
  return (
    <div className="rules">
      {players === 4 && (
        <>
          <div className="rule-row">
            <span className="rule-name">抄底</span>
            <div className="seg">
              <button className={rules.chaodi ? 'on' : ''} disabled={disabled} onClick={() => onChange({ chaodi: true })}>可以抄底</button>
              <button className={rules.chaodi ? '' : 'on'} disabled={disabled} onClick={() => onChange({ chaodi: false })}>不抄底</button>
            </div>
          </div>
          <div className="rule-row">
            <span className="rule-name">过河</span>
            <div className="seg">
              <button className={rules.guohe ? 'on' : ''} disabled={disabled} onClick={() => onChange({ guohe: true })}>可以过河</button>
              <button className={rules.guohe ? '' : 'on'} disabled={disabled} onClick={() => onChange({ guohe: false })}>不过河</button>
            </div>
          </div>
        </>
      )}
      <div className="rule-row">
        <span className="rule-name">造反</span>
        <div className="seg">
          <button className={z ? 'on' : ''} disabled={disabled} onClick={() => onChange({ zaofan: z ?? def })}>可以造反</button>
          <button className={z ? '' : 'on'} disabled={disabled} onClick={() => onChange({ zaofan: null })}>不能造反</button>
        </div>
      </div>
      {z && (
        <div className="zaofan-scores">
          <label>手里分数不多于 <ScoreInput label="造反下限" value={z.low} disabled={disabled} onCommit={setScore('low')} /> 分</label>
          <label>或不少于 <ScoreInput label="造反上限" value={z.high} disabled={disabled} onCommit={setScore('high')} /> 分</label>
          <label>庄家拿着底牌时不少于 <ScoreInput label="庄家造反上限" value={z.dealerHigh} disabled={disabled} onCommit={setScore('dealerHigh')} /> 分</label>
          {!disabled && def && !sameRule(z, def) && (
            <button type="button" className="link" onClick={() => onChange({ zaofan: def })}>恢复默认（{def.low} / {def.high} / {def.dealerHigh}）</button>
          )}
        </div>
      )}
      {problem && <div className="hint warn">{problem}</div>}
      <div className="hint">
        {players === 4 && '抄底：庄家埋完底后，其他人可以用一对级牌或一对王拿起底牌重新埋。过河：主牌不多于 5 张的人可以把主牌给对家，换回副牌。'}
        造反：手里 5、10、K 的分数太少或太多时，可以在庄家埋底{players === 4 ? '' : '或叫朋友'}时推倒重来、重新抢庄。
      </div>
    </div>
  );
}
