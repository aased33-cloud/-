'use strict';
const R=require('./shift-rules'),{lockPeriods}=require('./period-locks'),{autoCandidates}=require('./shift-routes'),{readState,asPlanner}=require('./holiday-plan-routes'),{planHolidays,eligibleStaff}=require('./holiday-planner'),{planWeekly,key}=require('./weekly-auto-planner');
const TYPES=[['하림','조출'],['하림','야간'],['싱그린','조출'],['싱그린','후출'],['동우','후출'],['동우','야간']];
const previous=m=>{const [y,n]=m.split('-').map(Number);return new Date(Date.UTC(y,n-2,1)).toISOString().slice(0,7)};
const dateKey=a=>[a.date,a.workplace,a.shift,a.slot].join('|');
module.exports=function(app,pool,user,admin,wrap){
 app.post('/api/auto-assignment',user,admin,wrap(async(req,res)=>{
  const month=String(req.body.month||''),scope=req.body.scope,mode=req.body.mode;
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!['weekly','monthly'].includes(scope)||!['keep','replace'].includes(mode))return res.status(400).json({error:'월과 자동배치 방법을 확인하세요.'});
  const slots=TYPES.flatMap(([workplace,shift])=>R.weeks(month,workplace,shift).flatMap(w=>Array.from({length:R.shiftSpec(workplace,shift).slots},(_,i)=>({workplace,shift,start:w.start,end:w.end,slot:i+1}))));
  const starts=[...new Set(slots.map(s=>s.start))].sort(),first=starts[0],last=slots.reduce((a,s)=>a>s.end?a:s.end,''),lastDate=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
  const adjacent=[...new Set([first.slice(0,7),month,last.slice(0,7)])].sort(),c=await pool.connect();
  try{await c.query('BEGIN');await lockPeriods(c,adjacent.flatMap(m=>['attendance:'+m,'holiday:'+m]));for(const m of adjacent)await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['monthly-workplaces-v1',m]);for(const start of starts)await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['weekly-shifts-v1',start]);await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['holiday-plan-v1',month]);
   const employees=(await c.query('SELECT id FROM employees WHERE active=true ORDER BY id')).rows;for(const p of employees){await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['shift-restrictions-v1',String(p.id)]);await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['night-exclusions-v1',String(p.id)])}
   let state=scope==='monthly'?await readState(c,month):null;
   if(state){const missing=state.staff.reduce((n,p)=>n+state.dates.filter(d=>!state.preferences.some(x=>String(x.employee_id)===String(p.id)&&x.date===d.date)).length,0);if(missing&&!req.body.confirm_missing){await c.query('ROLLBACK');return res.status(409).json({warning:`휴일 가능 여부 미등록 ${missing}건은 불가능으로 처리합니다. 계속할까요?`})}}
   const slotKey=new Set(slots.map(key));
   const weekly=(await c.query(`SELECT workplace,shift,week_start::text AS start,slot,employee_id FROM weekly_shift_assignments WHERE week_start >= ($1::date-interval '7 days') AND week_start <= $2::date`,[first,last])).rows.map(a=>({...a,end:R.add(a.start,R.shiftSpec(a.workplace,a.shift).days-1)}));
   const selected=weekly.filter(a=>slotKey.has(key(a)));
   if(mode==='replace'){
    const overrides=(await c.query(`SELECT workplace,shift,week_start::text AS start,slot FROM weekly_shift_overrides WHERE week_start >= $1::date AND week_start <= $2::date`,[first,last])).rows;
    if(overrides.some(a=>slotKey.has(key(a)))){await c.query('ROLLBACK');return res.status(409).json({error:'날짜별 대체가 있는 주별 담당이 있어 다시 배치할 수 없습니다. 기존 대체를 먼저 확인하거나 빈칸만 채우기를 선택하세요.'})}
    if(scope==='monthly'&&state.assignments.some(a=>a.employee_id&&state.support.some(s=>s.date===a.date&&String(s.employee_id)===String(a.employee_id)))){await c.query('ROLLBACK');return res.status(409).json({error:'휴일 작업장 지원과 연결된 배치가 있습니다. 지원 내역을 먼저 확인하거나 빈칸만 채우기를 선택하세요.'})}
    for(const a of selected)await c.query('DELETE FROM weekly_shift_assignments WHERE workplace=$1 AND shift=$2 AND week_start=$3::date AND slot=$4',[a.workplace,a.shift,a.start,a.slot]);
    if(scope==='monthly')await c.query(`DELETE FROM holiday_plan_assignments WHERE work_date >= $1::date AND work_date <= $2::date`,[month+'-01',lastDate]);
   }
   const keep=mode==='keep'?weekly:weekly.filter(a=>!slotKey.has(key(a)));
   const history=(await c.query(`SELECT workplace,shift,week_start::text AS start,employee_id FROM weekly_shift_assignments WHERE week_start >= ($1::date-interval '7 days') AND week_start < ($2::date+interval '1 month')`,[previous(month)+'-01',month+'-01'])).rows.filter(a=>!keep.some(x=>key({...a,slot:x.slot})===key(x)));
   const counts=history.map(a=>({workplace:a.workplace,shift:a.shift,employee_id:a.employee_id,month:R.countMonth(a.start),count:1}));
   const replacementCounts=(await c.query(`SELECT o.workplace,o.shift,o.week_start::text AS start,o.employee_id,count(DISTINCT o.work_date)::int AS days FROM weekly_shift_overrides o JOIN weekly_shift_assignments w USING(workplace,shift,week_start,slot) WHERE o.employee_id IS NOT NULL AND o.employee_id<>w.employee_id AND o.week_start >= ($1::date-interval '7 days') AND o.week_start < ($2::date+interval '1 month') GROUP BY o.workplace,o.shift,o.week_start,o.employee_id`,[previous(month)+'-01',month+'-01'])).rows;
   counts.push(...replacementCounts.filter(x=>x.days>=3).map(x=>({workplace:x.workplace,shift:x.shift,employee_id:x.employee_id,month:R.countMonth(x.start),count:0.5})));
   const holidays=(await c.query(`SELECT work_date::text AS date,workplace,shift,slot,employee_id FROM holiday_plan_assignments WHERE work_date >= $1::date AND work_date <= $2::date`,[first,last])).rows;
   const substitutions=(await c.query(`SELECT work_date::text AS date,employee_id FROM weekly_shift_overrides WHERE work_date >= $1::date AND work_date <= $2::date AND employee_id IS NOT NULL`,[first,last])).rows;
   const holidayInputs=[];for(const m of adjacent){const h=await readState(c,m);holidayInputs.push({state:h,input:asPlanner(h)})}
   const eligibleHoliday=(person,s)=>holidayInputs.every(({state:h,input})=>h.dates.filter(d=>d.date>=s.start&&d.date<=s.end).every(d=>{const shift=s.workplace==='하림'&&s.shift==='조출'?'주간':s.shift,requested=input.slots.find(x=>x.id===[d.date,s.workplace,shift,s.slot].join('|')),staff=input.staff.find(x=>String(x.id)===String(person.id));return !!requested&&!!staff&&eligibleStaff(staff,requested)}));
   const bySlot={};for(const s of slots){if(keep.some(x=>key(x)===key(s)))continue;const q={month,workplace:s.workplace,shift:s.shift,start:s.start,end:s.end},people=await autoCandidates(c,q);bySlot[key(s)]=people.filter(p=>eligibleHoliday(p,s)&&!substitutions.some(o=>o.date>=s.start&&o.date<=s.end&&String(o.employee_id)===String(p.id))&&!holidays.some(h=>h.date>=s.start&&h.date<=s.end&&(String(h.employee_id)===String(p.id)||(h.workplace===s.workplace&&h.shift===(s.workplace==='하림'&&s.shift==='조출'?'주간':s.shift)&&Number(h.slot)===s.slot))))}
   const plan=planWeekly({month,slots,existing:keep,candidatesBySlot:bySlot,counts});
   for(const a of plan.assignments)await c.query('INSERT INTO weekly_shift_assignments(workplace,shift,week_start,slot,employee_id) VALUES($1,$2,$3::date,$4,$5)',[a.workplace,a.shift,a.start,a.slot,a.employee_id]);
   let holiday=null;if(scope==='monthly'){
    state=await readState(c,month);const input=asPlanner(state);
    if(mode==='keep'){const added=state.assignments.filter(a=>!a.locked).map(a=>({slot_id:dateKey(a),type:a.external_id?'external':'staff',person_id:a.external_id||a.employee_id,locked:true}));input.locked.push(...added)}
    // An explicitly empty day override is a manual decision, not a free slot.
    for(const w of state.weeklyAssignments.filter(x=>x.employee_id===null))for(const p of input.staff){const a=p.availability[w.date],k=dateKey(w);if(a&&!a.blockedSlots.includes(k))a.blockedSlots.push(k)}
    // Sunday Dongwoo night is the same person as its Sunday-Friday weekly slot.
    // If that slot is still empty, leave the holiday slot empty as well.
    for(const slot of input.slots.filter(s=>s.workplace==='동우'&&s.kind==='야간'&&new Date(s.date+'T00:00:00Z').getUTCDay()===0)){
     const weekly=state.weeklyAssignments.find(w=>dateKey(w)===slot.id&&w.employee_id!==null);
     if(!weekly)for(const p of input.staff){const availability=p.availability[slot.date];if(availability&&!availability.blockedSlots.includes(String(slot.id)))availability.blockedSlots.push(String(slot.id))}
    }
    holiday=planHolidays(input);const fixed=new Set(input.locked.map(a=>String(a.slot_id)));
    for(const a of holiday.assignments){if(fixed.has(String(a.slot_id)))continue;const [date,workplace,shift,slot]=a.slot_id.split('|'),weeklySlot=state.weeklyAssignments.find(w=>w.date===date&&w.workplace===workplace&&w.shift===shift&&Number(w.slot)===Number(slot));if(weeklySlot){if(a.type!=='staff')throw Error('주별 담당자의 대체자는 내부 직원이어야 합니다.');await c.query('INSERT INTO weekly_shift_overrides(workplace,shift,week_start,slot,work_date,employee_id) VALUES($1,$2,$3::date,$4,$5::date,$6) ON CONFLICT(workplace,shift,week_start,slot,work_date) DO UPDATE SET employee_id=EXCLUDED.employee_id,updated_at=now()',[workplace,weeklySlot.weekly_shift,weeklySlot.week_start,Number(slot),date,Number(a.person_id)])}else await c.query('INSERT INTO holiday_plan_assignments(work_date,workplace,shift,slot,employee_id,external_id,locked) VALUES($1::date,$2,$3,$4,$5,$6,false)',[date,workplace,shift,Number(slot),a.type==='staff'?Number(a.person_id):null,a.type==='external'?Number(a.person_id):null])}
   }
   await c.query('INSERT INTO audit_log(actor_id,action,after_data) VALUES($1,$2,$3)',[req.user.id,'자동배치',JSON.stringify({month,scope,mode,weekly_added:plan.assignments.length,weekly_unfilled:plan.shortages.length,holiday_unfilled:holiday?.shortages.length??null})]);await c.query('COMMIT');res.json({ok:true,weekly_added:plan.assignments.length,weekly_shortages:plan.shortages,holiday_shortages:holiday?.shortages??[],holiday_conflicts:holiday?.conflicts??[]});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
};
