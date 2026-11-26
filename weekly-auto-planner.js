'use strict';
// Pure planning only; callers provide already validated candidate lists and existing
// assignments. Dates are inclusive ISO dates. Nothing is saved by this module.
const {countMonth}=require('./shift-rules');
const {randomInt}=require('node:crypto');
const overlaps=(a,b)=>a.start<=b.end&&b.start<=a.end;
const id=x=>String(x);
const key=s=>[s.workplace,s.shift,s.start,s.slot].join('|');
function planWeekly({month,slots,existing=[],candidatesBySlot,counts=[],random=randomInt}){
 const assignments=existing.map(a=>({...a})),occupied=new Set(assignments.map(key)),shortages=[];
 const usage=new Map();for(const c of counts){const k=[c.workplace,c.shift,id(c.employee_id),c.month].join('|');usage.set(k,(usage.get(k)||0)+Number(c.count||0))}
 for(const a of assignments){const m=countMonth(a.start);if(m){const k=[a.workplace,a.shift,id(a.employee_id),m].join('|');usage.set(k,(usage.get(k)||0)+1)}}
 const ordered=slots.slice().sort((a,b)=>a.start.localeCompare(b.start)||a.workplace.localeCompare(b.workplace,'ko')||a.shift.localeCompare(b.shift,'ko')||a.slot-b.slot);
 for(const slot of ordered){if(occupied.has(key(slot)))continue;
  const candidates=(candidatesBySlot[key(slot)]||[]).filter(p=>!p.reasons?.length&&!assignments.some(a=>id(a.employee_id)===id(p.id)&&overlaps(a,slot)));
  const prev=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-2,1)).toISOString().slice(0,7);
  const value=(p,m)=>usage.get([slot.workplace,slot.shift,id(p.id),m].join('|'))||0;
  candidates.sort((a,b)=>value(a,month)-value(b,month)||value(a,prev)-value(b,prev)||Number(!!a.attendance)-Number(!!b.attendance)||Number(b.base===slot.workplace)-Number(a.base===slot.workplace)||String(a.employee_no||'').localeCompare(String(b.employee_no||''),'ko',{numeric:true})||id(a.id).localeCompare(id(b.id)));
  if(!candidates.length){shortages.push(slot);continue}
  // Randomize only the Dongwoo night ordering among otherwise equivalent staff.
  let person=candidates[0];if(slot.workplace==='동우'&&slot.shift==='야간'){const same=candidates.filter(p=>value(p,month)===value(person,month)&&value(p,prev)===value(person,prev)&&!!p.attendance===!!person.attendance&&(p.base===slot.workplace)===(person.base===slot.workplace));person=same[random(same.length)]}
  const a={...slot,employee_id:person.id};assignments.push(a);occupied.add(key(slot));const m=countMonth(slot.start);if(m){const k=[slot.workplace,slot.shift,id(person.id),m].join('|');usage.set(k,(usage.get(k)||0)+1)}
 }
 const added=assignments.slice(existing.length);
 // Harim night has interchangeable numbered slots. Sort new pairs by employee
 // number only when both employees remain eligible for the other slot; existing
 // assignments and date overrides keep their slot identities.
 const groups=new Map();for(const a of added.filter(a=>a.workplace==='하림'&&a.shift==='야간')){const k=[a.workplace,a.shift,a.start].join('|');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(a)}
 for(const group of groups.values())if(group.length===2){group.sort((a,b)=>a.slot-b.slot);const [a,b]=group,find=(slot,employee)=> (candidatesBySlot[key(slot)]||[]).find(p=>id(p.id)===id(employee)&&!p.reasons?.length),left=find(a,a.employee_id),right=find(b,b.employee_id);if(left&&right&&String(left.employee_no||'').localeCompare(String(right.employee_no||''),'ko',{numeric:true})>0&&find(a,b.employee_id)&&find(b,a.employee_id))[a.employee_id,b.employee_id]=[b.employee_id,a.employee_id]}
 return {assignments:added,shortages};
}
module.exports={planWeekly,key};
