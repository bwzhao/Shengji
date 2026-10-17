import { describe, expect, it } from 'vitest';
import { applyAction, restartRound, viewFor } from '@shengji/engine';
import { traceFixture } from '../../../scripts/ui-fixtures.ts';
import { penaltySummary, type PenaltyView } from './penaltySummary.ts';

const live = (patch: Partial<PenaltyView> = {}): PenaltyView => ({ phase:'playing', round:1, penalties:[0,0,0,0,0,0], dealerTeam:[0,2], knownOpponents:[3], lastRound:null, ...patch });

describe('public penalty summary', () => {
  it('keeps ascending seat facts and signed confirmed effects separate from unresolved penalties', () => {
    const input = Object.freeze(live({ penalties:Object.freeze([20,40,10,30,0,0]), dealerTeam:Object.freeze([0,2]), knownOpponents:Object.freeze([3]) }));
    expect(penaltySummary(input)).toEqual({ kind:'live', confirmedDelta:0, pendingTotal:40, entries:[
      { seat:0, amount:20, side:'dealer', opponentDelta:20 },
      { seat:1, amount:40, side:'pending', opponentDelta:null },
      { seat:2, amount:10, side:'dealer', opponentDelta:10 },
      { seat:3, amount:30, side:'opponent', opponentDelta:-30 },
    ] });
    expect(penaltySummary(input)).toEqual(penaltySummary(input));
    expect(input.penalties).toEqual([20,40,10,30,0,0]);
  });
  it('reclassifies only published identities and never clamps or accumulates the delta', () => {
    const input=live({ penalties:[20,30,0,0,0,0], dealerTeam:[0], knownOpponents:[] });
    expect(penaltySummary(input)).toMatchObject({ confirmedDelta:20, pendingTotal:30 });
    expect(penaltySummary({...input,dealerTeam:[0,1]})).toMatchObject({ confirmedDelta:50, pendingTotal:0 });
    expect(penaltySummary({...input,knownOpponents:[1]})).toMatchObject({ confirmedDelta:-10, pendingTotal:0 });
    expect(penaltySummary({...input,penalties:[20,50,0,0,0,0],knownOpponents:[1]})?.entries[1]?.amount).toBe(50);
    expect(penaltySummary(live({ penalties:[0,0,0,30,0,0] }))?.confirmedDelta).toBe(-30);
  });
  it('uses the matching authoritative terminal result and ignores stale results in all preplay/reset phases', () => {
    const view=viewFor(traceFixture(5,295,true).state,0);
    expect(view.lastRound?.opponentPoints).toBe(0);
    expect(penaltySummary(view)).toMatchObject({ kind:'settled', confirmedDelta:-480, pendingTotal:0 });
    const terminal={...view, dealerTeam:[],knownOpponents:[],lastRound:{...view.lastRound!,penaltyDelta:123}};
    expect(penaltySummary(terminal)?.confirmedDelta).toBe(123);
    expect(penaltySummary(terminal)?.entries.every(e=>e.side!=='pending')).toBe(true);
    expect(penaltySummary({...terminal,lastRound:null})).toBeNull();
    expect(penaltySummary({...terminal,round:2})).toBeNull();
    expect(penaltySummary({...terminal,phase:'gameOver'})?.confirmedDelta).toBe(123);
    for(const phase of ['dealing','declaring','bottom','callFriend'] as const) expect(penaltySummary({...terminal,phase})).toBeNull();
    expect(penaltySummary(live())?.entries).toEqual([]);
    const next=applyAction(traceFixture(5,295,true).state,{type:'nextRound'});
    expect(next.ok).toBe(true);
    if(next.ok)expect(penaltySummary(viewFor(next.state,0))).toBeNull();
    const restart=restartRound(traceFixture(6,168).state);
    expect(penaltySummary(viewFor(restart.state,0))).toBeNull();
  });
});

describe('legal-action producer integration', () => {
  it('tracks cumulative failed throws through pending identities, reveals, and round reset', () => {
    let totals=Array(6).fill(0), previousRound=1, pendingSeen=false, resolvedSeen=false;
    traceFixture(6,461,false,(state,events)=>{
      if(state.round!==previousRound){totals=Array(6).fill(0);previousRound=state.round;}
      for(const event of events)if(event.type==='throwFailed')totals[event.seat]+=event.penalty;
      expect(state.penalties).toEqual(totals);
      const view=viewFor(state,0), summary=penaltySummary(view);
      if(state.phase==='playing') {
        const unknown=totals.reduce((sum,n,seat)=>sum+(!view.dealerTeam.includes(seat)&&!view.knownOpponents.includes(seat)?n:0),0);
        expect(summary?.pendingTotal).toBe(unknown);
        pendingSeen ||= unknown>0;
        resolvedSeen ||= pendingSeen && unknown===0 && totals.some(n=>n>0);
      }
    });
    expect(pendingSeen).toBe(true);expect(resolvedSeen).toBe(true);
    expect(penaltySummary(viewFor(traceFixture(6,168).state,0))).toMatchObject({confirmedDelta:50,pendingTotal:20});
    expect(penaltySummary(viewFor(traceFixture(6,234).state,0))).toMatchObject({confirmedDelta:50,pendingTotal:0});
    expect(penaltySummary(viewFor(traceFixture(6,461).state,0))?.entries).toEqual([]);
  });
  it.each([[5,295,-480,0],[6,281,140,310]] as const)('preserves %i-player final bottom scoring and authoritative delta', (players,cut,delta,total)=>{
    const state=traceFixture(players,cut,true).state, result=state.lastRound!;
    const before=JSON.stringify(result);
    expect(result.bottomBonus).toBeGreaterThan(0);
    expect(result.penaltyDelta).toBe(delta);
    expect(result.opponentPoints).toBe(total);
    expect(total).toBe(Math.max(0,result.capturedByOpponents+result.bottomBonus+delta));
    expect(penaltySummary(viewFor(state,0))).toMatchObject({kind:'settled',confirmedDelta:delta,pendingTotal:0});
    expect(JSON.stringify(result)).toBe(before);
  });
});
