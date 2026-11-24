'use strict';
// Planning is pure: it never writes to the database or changes locked rows.
// Slot and person identifiers are opaque strings; eligibility is supplied per day.
function flowGraph(size){return Array.from({length:size},()=>[])}
function edge(g,u,v,cap,cost,tag){const a={to:v,rev:g[v].length,cap,cost,initial:cap,tag},b={to:u,rev:g[u].length,cap:0,cost:-cost};g[u].push(a);g[v].push(b);return a}
function minCostMaxFlow(g,source,sink){let total=0;for(;;){
 const dist=Array(g.length).fill(Infinity),prev=Array(g.length),queued=Array(g.length).fill(false),queue=[source];dist[source]=0;queued[source]=true;
 for(let qi=0;qi<queue.length;qi++){const u=queue[qi];queued[u]=false;for(let i=0;i<g[u].length;i++){const e=g[u][i];if(e.cap>0&&dist[e.to]>dist[u]+e.cost){dist[e.to]=dist[u]+e.cost;prev[e.to]=[u,i];if(!queued[e.to]){queue.push(e.to);queued[e.to]=true}}}}
 if(!prev[sink])break;let v=sink;while(v!==source){const [u,i]=prev[v],e=g[u][i];e.cap--;g[v][e.rev].cap++;v=u}total++;
 }return total}
function dayKey(id,day){return `${id}|${day}`}
function validExternalSlot(s){return s.workplace==='하림'&&s.kind==='주간'&&s.role!=='조출'}
function eligibleStaff(p,s){
 const a=p.availability?.[s.date];
 if(!a || (s.kind==='야간' ? a.night!==true : a.day!==true))return false;
 if(Array.isArray(a.blockedSlots)&&a.blockedSlots.includes(String(s.id)))return false;
 if(s.kind==='야간'){
  if(s.workplace==='동우'&&!['동우','앤에프'].includes(p.base))return false;
  if(s.workplace==='하림'&&!['하림','싱그린','정다운','중앙축산'].includes(p.base))return false;
 }
 if(s.role==='조출' && p.blockHarimEarly)return false;
 return true;
}
function planHolidays({slots,staff,external,externalTarget,locked=[]}){
 if(!Number.isSafeInteger(externalTarget)||externalTarget<0)throw Error('타 사무소 인원 설정을 확인하세요.');
 const slotsById=new Map(slots.map(s=>[String(s.id),s]));if(slotsById.size!==slots.length)throw Error('중복된 근무 칸입니다.');
 const staffById=new Map(staff.map(p=>[String(p.id),p])),extById=new Map(external.map(p=>[String(p.id),p]));
 const out=[],conflicts=[],fixedSlots=new Set(),occupied=new Set(),counts=new Map(),extCounts=new Map(),extDayCounts=new Map(),fixedExternal=new Set();
 for(const a of locked){const s=slotsById.get(String(a.slot_id)),type=a.type,id=String(a.person_id),p=type==='staff'?staffById.get(id):type==='external'?extById.get(id):null;
  if(!s||!p||fixedSlots.has(String(a.slot_id))||occupied.has(dayKey(type+id,s.date)))throw Error('고정 배치에 중복 또는 잘못된 직원이 있습니다.');
  if(type==='external'&&!validExternalSlot(s))throw Error('타 사무소 지원은 하림 주간만 가능합니다.');
  const availability=type==='external'?p.availability?.[s.date]===true:eligibleStaff(p,s);
  if(!availability)conflicts.push({slot_id:String(a.slot_id),type,person_id:id,reason:'가능 여부 확인 필요'});
  fixedSlots.add(String(a.slot_id));occupied.add(dayKey(type+id,s.date));out.push({...a,slot_id:String(a.slot_id),person_id:id});
  if(type==='staff')counts.set(id,(counts.get(id)||0)+1);else{extCounts.set(id,(extCounts.get(id)||0)+1);fixedExternal.add(id);extDayCounts.set(s.date,(extDayCounts.get(s.date)||0)+1)}
 }
 if([...extCounts.values()].some(n=>n>2)||[...extDayCounts.values()].some(n=>n>2))throw Error('고정된 타 사무소 배치가 최대 인원을 초과합니다.');
 function run(second){
  const available=slots.filter(s=>!fixedSlots.has(String(s.id)));if(!available.length)return;
  let n=0;const node=()=>n++,source=node(),sink=node(),internal=staff.map(p=>({p,id:String(p.id),node:node()})),externalPeople=external.filter(p=>second?(extCounts.get(String(p.id))||0)===1:!fixedExternal.has(String(p.id))).map(p=>({p,id:String(p.id),node:node()}));
  const extGate=node(),extDates=new Map();for(const s of available)if(validExternalSlot(s)&&!extDates.has(s.date))extDates.set(s.date,{in:node(),out:node()});
  const slotNodes=available.map(s=>({s,node:node()})),intDay=[];for(const x of internal)for(const date of [...new Set(available.map(s=>s.date))])if(!occupied.has(dayKey('staff'+x.id,date)))intDay.push({x,date,node:node()});
  const extDay=[];for(const x of externalPeople)for(const date of extDates.keys())if(!occupied.has(dayKey('external'+x.id,date)))extDay.push({x,date,node:node()});
  const g=flowGraph(n);for(const sn of slotNodes)edge(g,sn.node,sink,1,0);
  for(const x of internal){const base=(x.p.initial_count||0)+(counts.get(x.id)||0);for(let i=0;i<available.length;i++)edge(g,source,x.node,1,100*(2*(base+i)+1));}
  for(const d of intDay){edge(g,d.x.node,d.node,1,0);for(const sn of slotNodes){const s=sn.s;if(s.date!==d.date||!eligibleStaff(d.x.p,s))continue;const preferred=(d.x.p.preferred||[]).includes(String(s.id));edge(g,d.node,sn.node,1,preferred?-10:0,{type:'staff',person_id:d.x.id,slot_id:String(s.id)});}}
  const remaining=second?externalPeople.length:Math.max(0,externalTarget-fixedExternal.size);edge(g,source,extGate,remaining,-100000);
  for(const x of externalPeople)edge(g,extGate,x.node,1,0);
  for(const d of extDay){if(d.x.p.availability?.[d.date]!==true)continue;edge(g,d.x.node,d.node,1,0);edge(g,d.node,extDates.get(d.date).in,1,0,{type:'external',person_id:d.x.id,date:d.date});}
  for(const [date,x] of extDates){edge(g,x.in,x.out,Math.max(0,2-(extDayCounts.get(date)||0)),0);for(const sn of slotNodes)if(sn.s.date===date&&validExternalSlot(sn.s))edge(g,x.out,sn.node,1,0,{type:'external_slot',date,slot_id:String(sn.s.id)});}
  minCostMaxFlow(g,source,sink);
  const extMatches=new Map(),extSlots=new Map();for(const links of g)for(const e of links)if(e.tag&&e.initial===1&&e.cap===0){const t=e.tag;if(t.type==='staff'){const a={type:'staff',person_id:t.person_id,slot_id:t.slot_id};out.push(a);const s=slotsById.get(t.slot_id);fixedSlots.add(t.slot_id);occupied.add(dayKey('staff'+t.person_id,s.date));counts.set(t.person_id,(counts.get(t.person_id)||0)+1)}else if(t.type==='external'){if(!extMatches.has(t.date))extMatches.set(t.date,[]);extMatches.get(t.date).push(t.person_id)}else if(t.type==='external_slot'){if(!extSlots.has(t.date))extSlots.set(t.date,[]);extSlots.get(t.date).push(t.slot_id)}}
  for(const [date,ids] of extMatches){const selected=extSlots.get(date)||[];if(ids.length!==selected.length)throw Error('타 사무소 배치를 확인할 수 없습니다.');ids.forEach((id,i)=>{out.push({type:'external',person_id:id,slot_id:selected[i]});fixedSlots.add(selected[i]);occupied.add(dayKey('external'+id,date));fixedExternal.add(id);extCounts.set(id,(extCounts.get(id)||0)+1);extDayCounts.set(date,(extDayCounts.get(date)||0)+1)})}
 }
 run(false);run(true);
 return {assignments:out,shortages:slots.filter(s=>!fixedSlots.has(String(s.id))),externalPeople:fixedExternal.size,conflicts};
}
module.exports={planHolidays};
