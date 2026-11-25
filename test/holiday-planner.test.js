'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{planHolidays}=require('../holiday-planner');
const slot=(id,date,workplace='하림',kind='주간')=>({id,date,workplace,kind});
test('fills available slots while balancing internal employees and respecting day/night',()=>{
 const slots=[slot('a','2026-12-05'),slot('b','2026-12-05','동우','야간'),slot('c','2026-12-12'),slot('d','2026-12-12','동우','야간')];
 const staff=[{id:1,availability:{'2026-12-05':{day:true,night:false},'2026-12-12':{day:true,night:false}}},{id:2,base:'동우',availability:{'2026-12-05':{day:false,night:true},'2026-12-12':{day:false,night:true}}},{id:3,base:'앤에프',availability:{'2026-12-05':{day:true,night:true},'2026-12-12':{day:true,night:true}}}];
 const r=planHolidays({slots,staff,external:[],externalTarget:0});assert.equal(r.shortages.length,0);const counts={};for(const a of r.assignments)counts[a.person_id]=(counts[a.person_id]||0)+1;assert(Math.max(...Object.values(counts))-Math.min(...Object.values(counts))<=1);
 for(const a of r.assignments){const s=slots.find(x=>x.id===a.slot_id),p=staff.find(x=>String(x.id)===a.person_id);assert.equal(p.availability[s.date][s.kind==='야간'?'night':'day'],true)}
});
test('external workers go to Harim day only, at most two per day, and target distinct people',()=>{
 const slots=[slot('a','2026-12-05'),slot('b','2026-12-05'),slot('c','2026-12-05'),slot('n','2026-12-05','하림','야간')],external=[1,2,3].map(id=>({id,availability:{'2026-12-05':true}}));
 const r=planHolidays({slots,staff:[],external,externalTarget:3});assert.equal(r.assignments.length,2);assert.equal(r.externalPeople,2);assert.equal(r.shortages.length,2);assert(r.assignments.every(a=>a.type==='external'&&['a','b','c'].includes(a.slot_id)));
});
test('second external assignment only fills shortage after first-pass capacity is exhausted',()=>{
 const slots=[slot('a','2026-12-05'),slot('b','2026-12-12')],external=[{id:7,availability:{'2026-12-05':true,'2026-12-12':true}}];
 let r=planHolidays({slots,staff:[],external,externalTarget:1});assert.equal(r.assignments.length,2);assert.equal(new Set(r.assignments.map(x=>x.person_id)).size,1);
 r=planHolidays({slots,staff:[{id:1,availability:{'2026-12-05':{day:true},'2026-12-12':{day:true}}}],external,externalTarget:1});assert.equal(r.assignments.filter(x=>x.type==='external').length,1);assert.equal(r.shortages.length,0);
});
test('locked assignments are preserved without duplicating a person on a day',()=>{
 const slots=[slot('a','2026-12-05'),slot('b','2026-12-05')],staff=[{id:1,availability:{'2026-12-05':{day:true}}}],locked=[{slot_id:'a',type:'staff',person_id:1}];const r=planHolidays({slots,staff,external:[],externalTarget:0,locked});assert.equal(r.assignments.length,1);assert.equal(r.shortages.length,1);assert.equal(r.assignments[0].slot_id,'a');
 assert.throws(()=>planHolidays({slots,staff,external:[],externalTarget:0,locked:[...locked,{slot_id:'b',type:'staff',person_id:1}]}));
});
test('excludes external support from Harim early and enforces night pools',()=>{
 const date='2026-12-05';
 const slots=[{...slot('early',date),role:'조출'},slot('day',date),slot('harim-night',date,'하림','야간'),slot('dongwoo-night',date,'동우','야간')];
 const staff=[{id:1,base:'동우',availability:{[date]:{day:false,night:true}}},{id:2,base:'싱그린',availability:{[date]:{day:false,night:true}}}];
 const external=[{id:3,availability:{[date]:true}}];
 const r=planHolidays({slots,staff,external,externalTarget:1});
 assert.equal(r.assignments.find(a=>a.slot_id==='day').type,'external');
 assert.equal(r.assignments.find(a=>a.slot_id==='harim-night').person_id,'2');
 assert.equal(r.assignments.find(a=>a.slot_id==='dongwoo-night').person_id,'1');
 assert(r.shortages.some(s=>s.id==='early'));
});
