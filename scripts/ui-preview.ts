// Local-only acceptance harness. Uses the real server, reducer, protocol and web build.
import { traceFixture } from './ui-fixtures.ts';
import { viewFor, levelRank } from '../packages/engine/src/index.ts';
import { startServer } from '../apps/server/src/server.ts';
import { Room } from '../apps/server/src/room.ts';
import { createGame, defaultConfig, createRng, applyAction, botDeclare, botAction, currentTurn, type Action, type GameState } from '../packages/engine/src/index.ts';
// Never uses snapshots or production rooms; all listeners bind to loopback.
const options = { dealIntervalMs: 3600000, declareGraceMs: 3600000, botDelayMs: 3600000, searchBudgetMs: 10 };
function fixture(players: 4|5|6, phase: string) {
  for (let seed=0;seed<100;seed++) {
    const initial=createGame(defaultConfig(players),`ui-acceptance-${players}-${seed}`);
    let state=initial; const actions: Action[]=[]; const rng=createRng('ui-acceptance');
    const apply=(a: Action) => { const r=applyAction(state,a); if(!r.ok)throw Error(r.error.message);state=r.state;actions.push(a); };
    while(state.phase==='dealing')apply({type:'dealCard'});
    const declaration=botDeclare(state,0,rng,{declareProbability:1,throwProbability:0});
    if(!declaration)continue;
    apply(declaration);
    if(phase!=='declaring')apply({type:'closeDeclaring'});
    while(!['declaring','bottom'].includes(phase) && state.phase!==phase) {
      const turn=currentTurn(state); if(turn===null)throw Error('No turn');
      const action=botAction(state,turn,rng); if(!action)throw Error('No action');apply(action);
    }
    return {state,initial,actions};
  }
  throw Error('No seed');
}
const servers=[];
for (const [port,players,phase,code] of [[4320,4,'playing','FOUR'],[4321,5,'bottom','FIVE'],[4322,6,'playing','SIXA'],[4323,6,'playing','SIXB'],[4324,6,'roundEnd','DONE'],[4325,6,'declaring','DECL']] as const) {
  const server=await startServer({port,host:'127.0.0.1',roomOptions:options}); servers.push(server);
  const {state,initial,actions}=fixture(players,phase);
  const room=new Room(code,players,'bot:0',options);
  room.state=state;room.botStrength='normal';
  room.roundLogs=[{round:state.round,initial,actions,names:['林间客','青山','听雨','南风','知秋','小满'].slice(0,players)}];
  for(let i=0;i<players;i++)room.seats[i]={token:`bot:${i}`,isBot:true,name:['林间客','青山','听雨','南风','知秋','小满'][i]};
  room.onChange=()=> {const human=room.seats.find(s=>s&&!s.isBot);if(human&&room.hostToken!==human.token){room.hostToken=human.token;room.broadcastRoom();}};
  server.registry.rooms.set(code,room);
  console.log(JSON.stringify({port,code,players,phase,hand:state.hands[0]?.length}));
}
// Additional reviewer-feedback scenarios; no hidden hands or public views are patched.
for (const [port, players, cut, pointBottom, code] of [
  [4326, 4, 103, false, 'FAIL'], [4327, 6, 168, false, 'PEND'],
  [4328, 6, 234, false, 'RESO'], [4329, 4, 308, false, 'LVL4'],
  [4330, 5, 461, false, 'LVL5'], [4331, 6, 461, false, 'LVL6'],
  [4332, 5, 295, true, 'END5'], [4333, 6, 281, true, 'END6'],
] as const) {
  const built = traceFixture(players, cut, pointBottom);
  const { state, initial, actions } = built;
  const server = await startServer({ port, host:'127.0.0.1', roomOptions:options }); servers.push(server);
  const room = new Room(code, players, 'bot:0', options);
  room.state = state; room.botStrength = 'normal';
  const names = ['林间客','青山','听雨','南风','知秋','小满'].slice(0,players);
  room.roundLogs = [{ round:state.round, initial, actions, names }];
  for (let i=0;i<players;i++) room.seats[i] = { token:`bot:${i}`, isBot:true, name:names[i]! };
  room.onChange = () => { const human=room.seats.find(s=>s&&!s.isBot); if(human&&room.hostToken!==human.token){room.hostToken=human.token;room.broadcastRoom();} };
  server.registry.rooms.set(code,room);
  const view = viewFor(state,0);
  console.log(JSON.stringify({ port, code, ...built, state:undefined, initial:undefined, actions:undefined, phase:state.phase, levels:state.levels.map(l=>levelRank(l,state.config)), penalties:state.penalties, dealerTeam:view.dealerTeam, knownOpponents:view.knownOpponents, result:state.lastRound && { delta:state.lastRound.penaltyDelta, total:state.lastRound.opponentPoints } }));
}
{
  const port=4334, code='CALL', players=6;
  const server=await startServer({port,host:'127.0.0.1',roomOptions:options}); servers.push(server);
  const {state,initial,actions}=fixture(players,'callFriend');
  if(state.dealer!==0)throw Error('CALL fixture must join dealer seat 0');
  const room=new Room(code,players,'bot:0',options);room.state=state;room.botStrength='normal';
  const names=['林间客','青山','听雨','南风','知秋','小满'];
  room.roundLogs=[{round:state.round,initial,actions,names}];
  for(let i=0;i<players;i++)room.seats[i]={token:`bot:${i}`,isBot:true,name:names[i]!};
  room.onChange=()=>{const human=room.seats.find(s=>s&&!s.isBot);if(human&&room.hostToken!==human.token){room.hostToken=human.token;room.broadcastRoom();}};
  server.registry.rooms.set(code,room);console.log(JSON.stringify({port,code,players,phase:state.phase}));
}
// Cover the remaining independent notation contexts with fixed legal histories.
for (const [port, code, kind] of [[4335,'OPTS','options'],[4336,'BOTT','bottom'],[4337,'FOUR','four-suit-friends']] as const) {
  const players = kind === 'bottom' ? 4 : 6;
  const roundTwo = kind === 'bottom' ? traceFixture(4,308) : kind === 'four-suit-friends' ? traceFixture(6,461) : null;
  const initial = roundTwo?.initial ?? createGame(defaultConfig(players),'pr9-options-0');
  let state = initial;
  const actions:Action[]=[];
  const apply = (action:Action) => { const result=applyAction(state,action);if(!result.ok)throw Error(result.error.message);state=result.state;actions.push(action); };
  if(kind==='four-suit-friends') {
    for(const action of roundTwo!.actions) { if(action.type==='callFriend')break;apply(action); }
    if(state.phase!=='callFriend'||state.trumpSuit!==null)throw Error('Expected four-suit friend choice');
  } else {
    while(state.phase==='dealing')apply({type:'dealCard'});
    if(kind==='bottom')apply({type:'closeDeclaring'});
  }
  const server=await startServer({port,host:'127.0.0.1',roomOptions:options});servers.push(server);
  const room=new Room(code,players,'bot:0',options);room.state=state;room.botStrength='normal';
  const names=['林间客','青山','听雨','南风','知秋','小满'].slice(0,players);
  room.roundLogs=[{round:state.round,initial,actions,names}];
  // Ordinary join takes the first available bot: reserve preceding seats as offline test players.
  const viewer=kind==='four-suit-friends'?state.dealer!:0;
  for(let i=0;i<players;i++) {
    room.seats[i]={token:`fixture:${i}`,isBot:i>=viewer,name:names[i]!};
    if(i<viewer)room.members.set(`fixture:${i}`,{token:`fixture:${i}`,name:names[i]!,socket:null});
  }
  room.onChange=()=>{const human=[...room.members.values()].find(m=>m.socket);if(human&&room.hostToken!==human.token){room.hostToken=human.token;room.broadcastRoom();}};
  server.registry.rooms.set(code,room);console.log(JSON.stringify({port,code,players,phase:state.phase,viewer,trumpSuit:state.trumpSuit}));
}
for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,()=>{void Promise.all(servers.map(s=>s.close())).then(()=>process.exit(0));});
