'use strict';
const {validDate}=require('./rules');
const {planHolidays,eligibleStaff}=require('./holiday-planner');
const {lockPeriods}=require('./period-locks');
const shiftRules=require('./shift-rules');
const WORK=['하림','싱그린','정다운','동우','앤에프','중앙축산'],SHIFTS=['조출','주간','후출','야간'];
const okMonth=m=>/^\d{4}-(0[1-9]|1[0-2])$/.test(m||'');
function dayOf(date){return new Date(date+'T00:00:00Z').getUTCDay()}
function defaults(date,workplace,shift){const weekday=dayOf(date)>=1&&dayOf(date)<=5;if(workplace==='하림')return shift==='주간'?6:shift==='야간'?2:0;if(workplace==='동우')return shift==='주간'?2:shift==='후출'?1:shift==='야간'?2:0;if(workplace==='싱그린')return shift==='조출'||shift==='후출'?1:0;if(workplace==='정다운'&&weekday&&shift==='주간')return 1;return 0}
function key(date,workplace,shift,slot){return [date,workplace,shift,slot].join('|')}
async function readState(c,month){
 const param=[month+'-01'],dates=(await c.query(`SELECT id,holiday_date::text date,label FROM holiday_dates WHERE excluded=false AND holiday_date >= $1::date AND holiday_date < ($1::date+interval '1 month') ORDER BY holiday_date`,param)).rows;
 const staff=(await c.query(`SELECT e.id,e.name,e.employee_no,coalesce(a.workplace,'미배치') base FROM employees e LEFT JOIN monthly_workplace_assignments a ON a.employee_id=e.id AND a.month=$1::date WHERE e.active=true ORDER BY e.name,e.employee_no`,param)).rows;
 const preferences=(await c.query(`SELECT p.employee_id,h.holiday_date::text date,p.status,p.night_status FROM holiday_preferences p JOIN holiday_dates h ON h.id=p.holiday_id WHERE h.excluded=false AND h.holiday_date >= $1::date AND h.holiday_date < ($1::date+interval '1 month')`,param)).rows;
 const external=(await c.query('SELECT id,name FROM holiday_external_people WHERE month=$1::date AND active=true ORDER BY name,id',param)).rows;
 const inactiveExternal=(await c.query('SELECT id,name FROM holiday_external_people WHERE month=$1::date AND active=false ORDER BY name,id',param)).rows;
 const externalAvailability=(await c.query(`SELECT a.external_id,a.work_date::text date,a.available FROM holiday_external_availability a JOIN holiday_external_people p ON p.id=a.external_id WHERE p.month=$1::date AND p.active=true`,param)).rows;
 const requirements=(await c.query(`SELECT work_date::text date,workplace,shift,required FROM holiday_plan_requirements WHERE work_date >= $1::date AND work_date < ($1::date+interval '1 month')`,param)).rows;
 const assignments=(await c.query(`SELECT work_date::text date,workplace,shift,slot,employee_id,external_id,locked FROM holiday_plan_assignments WHERE work_date >= $1::date AND work_date < ($1::date+interval '1 month')`,param)).rows;
 const attendance=(await c.query(`SELECT employee_id,type,start_date::text AS start_date,end_date::text AS end_date,start_time::text AS start_time,end_time::text AS end_time FROM attendance WHERE start_date < ($1::date+interval '1 month 7 days') AND end_date >= ($1::date-interval '7 days')`,param)).rows;
 const support=(await c.query(`SELECT work_date::text AS date,employee_id,workplace FROM daily_workplace_support WHERE work_date >= $1::date AND work_date < ($1::date+interval '1 month')`,param)).rows;
 const exclusions=(await c.query('SELECT employee_id FROM employee_night_exclusions WHERE blocked=true')).rows;
 const restrictions=(await c.query('SELECT employee_id,restriction FROM employee_shift_restrictions')).rows;
 const unavailableWeeks=(await c.query(`SELECT employee_id,workplace,week_start::text AS week_start FROM night_unavailable_weeks WHERE week_start >= ($1::date-interval '7 days') AND week_start < ($1::date+interval '1 month')`,param)).rows;
 const weekly=(await c.query(`SELECT workplace,shift,week_start::text AS week_start,slot,employee_id FROM weekly_shift_assignments WHERE week_start >= ($1::date-interval '7 days') AND week_start < ($1::date+interval '1 month')`,param)).rows;
 const overrides=(await c.query(`SELECT workplace,shift,week_start::text AS week_start,slot,work_date::text AS work_date,employee_id FROM weekly_shift_overrides WHERE work_date >= $1::date AND work_date < ($1::date+interval '1 month')`,param)).rows;
 const weeklyAssignments=[];
 for(const w of weekly){const spec=shiftRules.shiftSpec(w.workplace,w.shift);if(!spec)continue;for(const d of dates){if(d.date<w.week_start||d.date>shiftRules.add(w.week_start,spec.days-1))continue;const o=overrides.find(x=>x.workplace===w.workplace&&x.shift===w.shift&&x.week_start===w.week_start&&Number(x.slot)===Number(w.slot)&&x.work_date===d.date),employee=o?o.employee_id:w.employee_id;weeklyAssignments.push({date:d.date,workplace:w.workplace,shift:w.workplace==='하림'&&w.shift==='조출'?'주간':w.shift,slot:Number(w.slot),employee_id:employee,external_id:null,locked:true,weekly:true,week_start:w.week_start,weekly_shift:w.shift});}}
 const setting=(await c.query('SELECT external_target FROM holiday_plan_settings WHERE month=$1::date',param)).rows[0];
 return {month,dates,staff,preferences,external,inactiveExternal,externalAvailability,requirements,assignments,weeklyAssignments,weekly,overrides,attendance,support,exclusions,restrictions,unavailableWeeks,externalTarget:setting?.external_target??0};
}
function needFor(state,date,workplace,shift){const saved=state.requirements.find(x=>x.date===date&&x.workplace===workplace&&x.shift===shift);return saved?saved.required:defaults(date,workplace,shift)}
function asPlanner(state){
 const slots=[];for(const d of state.dates)for(const w of WORK)for(const shift of SHIFTS)for(let slot=1;slot<=needFor(state,d.date,w,shift);slot++)slots.push({id:key(d.date,w,shift,slot),date:d.date,workplace:w,kind:shift,role:w==='하림'&&shift==='주간'&&slot===1?'조출':null});
 const staff=state.staff.map(p=>{
  const id=String(p.id),attendance=state.attendance.filter(a=>String(a.employee_id)===id);
  const blockHarimEarly=state.restrictions.some(r=>String(r.employee_id)===id&&r.restriction==='하림조출');
  const nightExcluded=state.exclusions.some(x=>String(x.employee_id)===id);
  const availability=Object.fromEntries(state.dates.map(({date})=>{
   const a=state.preferences.find(x=>String(x.employee_id)===id&&x.date===date);
   const blockedSlots=[];
   for(const s of slots.filter(s=>s.date===date)){
    if(state.support.some(x=>String(x.employee_id)===id&&x.date===date&&x.workplace!==s.workplace)){blockedSlots.push(s.id);continue}
    const today=attendance.some(x=>x.start_date<=s.date&&x.end_date>=s.date&&(s.kind!=='야간'||x.type!=='외출'));
    if(today){blockedSlots.push(s.id);continue}
    if(s.kind==='야간'){
     const week=shiftRules.weeks(state.month,s.workplace,'야간').find(w=>w.start<=s.date&&w.end>=s.date);
     if(nightExcluded||!week||shiftRules.hasAttendance(attendance,week.start,week.end,true)||state.unavailableWeeks.some(x=>String(x.employee_id)===id&&x.workplace===s.workplace&&x.week_start===week.start))blockedSlots.push(s.id);
    }
    if(s.workplace==='동우'&&s.kind==='후출'&&state.restrictions.some(r=>String(r.employee_id)===id&&r.restriction==='동우후출'))blockedSlots.push(s.id);
   }
   return [date,{day:a?.status==='available',night:a?.night_status==='allowed',blockedSlots}];
  }));
  const preferred=slots.filter(s=>state.weekly.some(w=>String(w.employee_id)===id&&shiftRules.add(w.week_start,5)===s.date&&w.workplace===s.workplace&&((w.workplace==='하림'&&w.shift==='조출'&&s.kind==='주간'&&s.role==='조출')||((w.workplace==='동우'&&w.shift==='후출'||w.workplace==='싱그린')&&w.shift===s.kind&&Number(w.slot)===Number(s.id.split('|').at(-1)))))).map(s=>s.id);
  return {id:p.id,base:p.base,blockHarimEarly,availability,preferred};
 });
 const external=state.external.map(p=>({id:p.id,availability:Object.fromEntries(state.externalAvailability.filter(a=>String(a.external_id)===String(p.id)).map(a=>[a.date,a.available]))}));
 const locked=[...state.assignments.filter(a=>a.locked),...state.weeklyAssignments.filter(w=>w.employee_id!==null&&!state.assignments.some(a=>a.locked&&a.date===w.date&&a.workplace===w.workplace&&a.shift===w.shift&&Number(a.slot)===Number(w.slot)&&String(a.employee_id)===String(w.employee_id)))].map(a=>({slot_id:key(a.date,a.workplace,a.shift,a.slot),type:a.external_id?'external':'staff',person_id:a.external_id||a.employee_id,locked:true}));
 return {slots,staff,external,externalTarget:state.externalTarget,locked};
}
module.exports=function attachHolidayPlan(app,pool,user,admin,wrap){
 const monthOf=(req,res)=>{const m=String(req.query.month||req.body?.month||'');if(!okMonth(m)){res.status(400).json({error:'월을 확인하세요.'});return null}return m};
 const lock=async(c,m)=>{const d=m+'-01',last=new Date(Date.UTC(Number(m.slice(0,4)),Number(m.slice(5,7)),0)).toISOString().slice(0,10);const keys=[shiftRules.add(d,-7).slice(0,7),m,shiftRules.add(last,7).slice(0,7)];await lockPeriods(c,keys.flatMap(x=>[`attendance:${x}`,`holiday:${x}`]));await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['holiday-plan-v1',m])};
 const audit=async(c,actor,action,after)=>c.query('INSERT INTO audit_log(actor_id,action,after_data) VALUES($1,$2,$3)',[actor,action,JSON.stringify(after)]);
 app.get('/api/holiday-plan',user,admin,wrap(async(req,res)=>{
  const m=monthOf(req,res);if(!m)return;const state=await readState(pool,m),input=asPlanner(state);
  const defaultsBySlot=Object.fromEntries(state.dates.flatMap(d=>WORK.flatMap(w=>SHIFTS.map(s=>[key(d.date,w,s,''),needFor(state,d.date,w,s)]))));
  const conflicts=[];
  for(const a of state.assignments){
   const slot=input.slots.find(s=>s.id===key(a.date,a.workplace,a.shift,a.slot));
   const person=a.external_id?input.external.find(p=>String(p.id)===String(a.external_id)):input.staff.find(p=>String(p.id)===String(a.employee_id));
   if(!slot||!person||(a.external_id?person.availability?.[a.date]!==true:!eligibleStaff(person,slot)))conflicts.push({date:a.date,workplace:a.workplace,shift:a.shift,slot:a.slot,employee_id:a.employee_id,external_id:a.external_id,reason:'현재 등록 상태 또는 근태 확인 필요'});
  }
  for(const w of state.weeklyAssignments.filter(x=>x.employee_id!==null)){
   const slot=input.slots.find(s=>s.id===key(w.date,w.workplace,w.shift,w.slot)),person=input.staff.find(p=>String(p.id)===String(w.employee_id));
   if(!slot||!person||!eligibleStaff(person,slot))conflicts.push({date:w.date,workplace:w.workplace,shift:w.shift,slot:w.slot,employee_id:w.employee_id,reason:!slot?'필요 인원과 주별 담당이 맞지 않음':!person?'비활성 직원':'가능 여부 또는 근태 확인 필요'});
   const clash=state.assignments.find(a=>a.date===w.date&&(String(a.employee_id)===String(w.employee_id)||key(a.date,a.workplace,a.shift,a.slot)===key(w.date,w.workplace,w.shift,w.slot))&&(String(a.employee_id)!==String(w.employee_id)||key(a.date,a.workplace,a.shift,a.slot)!==key(w.date,w.workplace,w.shift,w.slot)));
   if(clash)conflicts.push({date:w.date,workplace:w.workplace,shift:w.shift,slot:w.slot,employee_id:w.employee_id,reason:'저장된 휴일 배치와 충돌'});
  }
  const candidates=Object.fromEntries(input.slots.map(slot=>{
   const taken=[...state.assignments,...state.weeklyAssignments.filter(a=>a.employee_id!==null)].filter(a=>a.date===slot.date&&key(a.date,a.workplace,a.shift,a.slot)!==slot.id);
   const staff=input.staff.filter(p=>!taken.some(a=>String(a.employee_id)===String(p.id))).flatMap(p=>{
    if(eligibleStaff(p,slot))return [{type:'staff',id:p.id,warning:false}];
    if(slot.kind==='야간')return [];
    const preference=p.availability[slot.date];if(preference?.day)return [];
    const alternative={...p,availability:{...p.availability,[slot.date]:{...preference,day:true}}};
    return eligibleStaff(alternative,slot)?[{type:'staff',id:p.id,warning:true}]:[];
   });
   const external=slot.workplace==='하림'&&slot.kind==='주간'&&slot.role!=='조출'&&taken.filter(a=>a.external_id!==null).length<2?input.external.filter(p=>p.availability[slot.date]&&!taken.some(a=>String(a.external_id)===String(p.id))&&state.assignments.filter(a=>String(a.external_id)===String(p.id)).length<2).map(p=>({type:'external',id:p.id,warning:false})):[];
   return [slot.id,[...staff,...external]];
  }));
  const shown=state.assignments.filter(a=>!state.weeklyAssignments.some(w=>w.date===a.date&&w.workplace===a.workplace&&w.shift===a.shift&&Number(w.slot)===Number(a.slot)));res.json({...state,assignments:[...shown,...state.weeklyAssignments.filter(a=>a.employee_id!==null)],workplaces:WORK,shifts:SHIFTS,defaults:defaultsBySlot,candidates,conflicts});
 }));
 app.post('/api/holiday-plan/external',user,admin,wrap(async(req,res)=>{const m=monthOf(req,res);if(!m)return;const name=String(req.body.name||'').trim();if(!name||name.length>100)return res.status(400).json({error:'지원자 이름을 확인하세요.'});const c=await pool.connect();try{await c.query('BEGIN');await lock(c,m);const r=await c.query('INSERT INTO holiday_external_people(month,name) VALUES($1::date,$2) RETURNING id,name',[m+'-01',name]);await audit(c,req.user.id,'타 사무소 지원자 등록',{month:m,person_id:r.rows[0].id,name});await c.query('COMMIT');res.json(r.rows[0])}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}));
 app.patch('/api/holiday-plan/external/:id',user,admin,wrap(async(req,res)=>{
  const m=monthOf(req,res);if(!m)return;const id=Number(req.params.id),name=String(req.body.name||'').trim(),active=req.body.active;
  if(!Number.isSafeInteger(id)||id<1||!name||name.length>100||typeof active!=='boolean')return res.status(400).json({error:'지원자 정보를 확인하세요.'});
  const c=await pool.connect();try{await c.query('BEGIN');await lock(c,m);const old=(await c.query('SELECT id,name,active FROM holiday_external_people WHERE id=$1 AND month=$2::date FOR UPDATE',[id,m+'-01'])).rows[0];if(!old){await c.query('ROLLBACK');return res.status(404).json({error:'지원자를 찾을 수 없습니다.'})}if(!active&&(await c.query('SELECT 1 FROM holiday_plan_assignments WHERE external_id=$1 LIMIT 1',[id])).rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'기존 휴일 배치를 먼저 해제하세요.'})}await c.query('UPDATE holiday_external_people SET name=$2,active=$3 WHERE id=$1',[id,name,active]);await audit(c,req.user.id,'타 사무소 지원자 변경',{month:m,id,before:old,name,active});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 app.put('/api/holiday-plan/external-availability',user,admin,wrap(async(req,res)=>{const m=monthOf(req,res);if(!m)return;const id=Number(req.body.external_id),date=String(req.body.date||''),available=req.body.available;if(!Number.isSafeInteger(id)||id<1||!validDate(date)||!date.startsWith(m)||typeof available!=='boolean')return res.status(400).json({error:'지원자와 날짜를 확인하세요.'});const c=await pool.connect();try{await c.query('BEGIN');await lock(c,m);const x=await c.query('SELECT id FROM holiday_external_people WHERE id=$1 AND month=$2::date AND active=true',[id,m+'-01']);const h=await c.query('SELECT id FROM holiday_dates WHERE holiday_date=$1::date AND excluded=false',[date]);if(!x.rowCount||!h.rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'지원자 또는 휴일이 없습니다.'})}if(!available&&!req.body.confirm_conflict&&(await c.query('SELECT 1 FROM holiday_plan_assignments WHERE external_id=$1 AND work_date=$2::date',[id,date])).rowCount){await c.query('ROLLBACK');return res.status(409).json({warning:'이미 배치된 지원자입니다. 불가능으로 변경하면 충돌이 표시됩니다. 계속할까요?'})}await c.query('INSERT INTO holiday_external_availability(external_id,work_date,available) VALUES($1,$2::date,$3) ON CONFLICT(external_id,work_date) DO UPDATE SET available=EXCLUDED.available',[id,date,available]);await audit(c,req.user.id,'타 사무소 가능 여부 변경',{month:m,external_id:id,date,available});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}));
 app.put('/api/holiday-plan/settings',user,admin,wrap(async(req,res)=>{const m=monthOf(req,res);if(!m)return;const n=Number(req.body.external_target);if(!Number.isSafeInteger(n)||n<0||n>100)return res.status(400).json({error:'지원 인원을 확인하세요.'});const c=await pool.connect();try{await c.query('BEGIN');await lock(c,m);await c.query('INSERT INTO holiday_plan_settings(month,external_target) VALUES($1::date,$2) ON CONFLICT(month) DO UPDATE SET external_target=EXCLUDED.external_target',[m+'-01',n]);await audit(c,req.user.id,'휴일 지원 인원 변경',{month:m,external_target:n});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}));
 app.put('/api/holiday-plan/requirements',user,admin,wrap(async(req,res)=>{const m=monthOf(req,res);if(!m)return;const date=String(req.body.date||''),workplace=String(req.body.workplace||''),shift=String(req.body.shift||''),required=Number(req.body.required);if(!validDate(date)||!date.startsWith(m)||!WORK.includes(workplace)||!SHIFTS.includes(shift)||!Number.isSafeInteger(required)||required<0||required>30)return res.status(400).json({error:'날짜와 필요 인원을 확인하세요.'});if(workplace==='하림'&&shift==='조출'&&required!==0)return res.status(400).json({error:'하림 조출은 주간 1번에 포함됩니다. 하림 주간 인원을 설정하세요.'});const c=await pool.connect();try{await c.query('BEGIN');await lock(c,m);if(!(await c.query('SELECT id FROM holiday_dates WHERE holiday_date=$1::date AND excluded=false',[date])).rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'휴일 날짜가 아닙니다.'})}const used=await c.query('SELECT 1 FROM holiday_plan_assignments WHERE work_date=$1::date AND workplace=$2 AND shift=$3 AND slot>$4 LIMIT 1',[date,workplace,shift,required]);if(used.rowCount||(await readState(c,m)).weeklyAssignments.some(w=>w.employee_id!==null&&w.date===date&&w.workplace===workplace&&w.shift===shift&&w.slot>required)){await c.query('ROLLBACK');return res.status(409).json({error:'기존 배치를 먼저 해제한 후 인원을 줄이세요.'})}await c.query('INSERT INTO holiday_plan_requirements(work_date,workplace,shift,required) VALUES($1::date,$2,$3,$4) ON CONFLICT(work_date,workplace,shift) DO UPDATE SET required=EXCLUDED.required',[date,workplace,shift,required]);await audit(c,req.user.id,'휴일 필요 인원 변경',{date,workplace,shift,required});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}));
 app.put('/api/holiday-plan/lock',user,admin,wrap(async(req,res)=>{
  const m=monthOf(req,res);if(!m)return;const date=String(req.body.date||''),workplace=String(req.body.workplace||''),shift=String(req.body.shift||''),slot=Number(req.body.slot),locked=req.body.locked;
  if(!validDate(date)||date.slice(0,7)!==m||!WORK.includes(workplace)||!SHIFTS.includes(shift)||!Number.isSafeInteger(slot)||slot<1||slot>30||typeof locked!=='boolean')return res.status(400).json({error:'근무 칸과 고정 여부를 확인하세요.'});
  const c=await pool.connect();try{await c.query('BEGIN');await lock(c,m);const r=await c.query('UPDATE holiday_plan_assignments SET locked=$5 WHERE work_date=$1::date AND workplace=$2 AND shift=$3 AND slot=$4 RETURNING employee_id,external_id',[date,workplace,shift,slot,locked]);if(!r.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'배치가 없거나 주별 담당으로 관리되는 칸입니다.'})}await audit(c,req.user.id,'휴일근무 배치 고정 변경',{date,workplace,shift,slot,locked});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 app.put('/api/holiday-plan/assignment',user,admin,wrap(async(req,res)=>{
  const m=monthOf(req,res);if(!m)return;
  const date=String(req.body.date||''),workplace=String(req.body.workplace||''),shift=String(req.body.shift||''),slot=Number(req.body.slot),employeeId=req.body.employee_id==null?null:Number(req.body.employee_id),externalId=req.body.external_id==null?null:Number(req.body.external_id);
  if(!validDate(date)||date.slice(0,7)!==m||!WORK.includes(workplace)||!SHIFTS.includes(shift)||!Number.isSafeInteger(slot)||slot<1||slot>30||(employeeId!==null&&(!Number.isSafeInteger(employeeId)||employeeId<1))||(externalId!==null&&(!Number.isSafeInteger(externalId)||externalId<1))||(employeeId!==null&&externalId!==null))return res.status(400).json({error:'날짜와 배치할 직원을 확인하세요.'});
  const c=await pool.connect();try{
   await c.query('BEGIN');await lock(c,m);const state=await readState(c,m),input=asPlanner(state),target=input.slots.find(x=>x.id===key(date,workplace,shift,slot));
   if(!target){await c.query('ROLLBACK');return res.status(400).json({error:'휴일 또는 필요한 근무 칸이 아닙니다.'})}
   const prior=state.assignments.find(a=>a.date===date&&a.workplace===workplace&&a.shift===shift&&Number(a.slot)===slot);
   const weeklySlot=state.weeklyAssignments.find(a=>a.date===date&&a.workplace===workplace&&a.shift===shift&&Number(a.slot)===slot);
   const other=[...state.assignments,...state.weeklyAssignments.filter(a=>a.employee_id!==null)].filter(a=>!(a.date===date&&a.workplace===workplace&&a.shift===shift&&Number(a.slot)===slot));
   if(weeklySlot&&prior){await c.query('ROLLBACK');return res.status(409).json({error:'주별 담당자와 휴일 배치가 겹칩니다. 기존 배치를 확인하세요.'})}
   if(employeeId!==null){
    const p=input.staff.find(x=>Number(x.id)===employeeId);if(!p){await c.query('ROLLBACK');return res.status(400).json({error:'활성 직원을 선택하세요.'})}
    if(other.some(x=>x.date===date&&Number(x.employee_id)===employeeId)){await c.query('ROLLBACK');return res.status(409).json({error:'해당 날짜에 이미 다른 근무에 배치되어 있습니다.'})}
    const pref=state.preferences.find(x=>Number(x.employee_id)===employeeId&&x.date===date);
    if(shift!=='야간'&&pref?.status!=='available'){
     if(!req.body.confirm_unavailable){await c.query('ROLLBACK');return res.status(409).json({warning:'휴일근무가 불가능 또는 미등록인 직원입니다. 배치하시겠습니까?'})}
     p.availability[date].day=true;
    }
    if(!eligibleStaff(p,target)){await c.query('ROLLBACK');return res.status(409).json({error:shift==='야간'?'야간 가능 여부, 주간 근태 및 야간 제한을 확인하세요.':'해당 날짜 근태 또는 근무 제한을 확인하세요.'})}
   } else if(externalId!==null){
    const person=input.external.find(x=>Number(x.id)===externalId);if(weeklySlot||!person||workplace!=='하림'||shift!=='주간'||slot===1){await c.query('ROLLBACK');return res.status(400).json({error:'타 사무소 직원은 하림 주간의 조출을 제외한 칸에만 배치할 수 있습니다.'})}
    if(!person.availability[date]){await c.query('ROLLBACK');return res.status(409).json({error:'해당 날짜 근무 가능한 타 사무소 직원을 선택하세요.'})}
    if(other.some(x=>x.date===date&&Number(x.external_id)===externalId)||other.filter(x=>x.date===date&&x.external_id!==null).length>=2){await c.query('ROLLBACK');return res.status(409).json({error:'중복 배치 또는 하루 지원 인원 2명을 초과할 수 없습니다.'})}
    const count=other.filter(x=>Number(x.external_id)===externalId).length;
    if(count>=2){await c.query('ROLLBACK');return res.status(409).json({error:'타 사무소 직원은 한 달에 최대 2회입니다.'})}
    if(count===1){const internalAvailable=input.staff.some(p=>!other.some(x=>x.date===date&&Number(x.employee_id)===Number(p.id))&&eligibleStaff(p,target));const usedPeople=new Set(other.filter(x=>x.external_id!==null).map(x=>String(x.external_id)));const externalAvailable=usedPeople.size<state.externalTarget&&input.external.some(p=>Number(p.id)!==externalId&&!usedPeople.has(String(p.id))&&p.availability[date]===true);if(internalAvailable||externalAvailable){await c.query('ROLLBACK');return res.status(409).json({error:'해당 칸에 처음 배치할 수 있는 직원이 있어 지원자의 두 번째 근무를 배정할 수 없습니다.'})}}
   }
   if(weeklySlot){await c.query('INSERT INTO weekly_shift_overrides(workplace,shift,week_start,slot,work_date,employee_id) VALUES($1,$2,$3::date,$4,$5::date,$6) ON CONFLICT(workplace,shift,week_start,slot,work_date) DO UPDATE SET employee_id=EXCLUDED.employee_id,updated_at=now()',[weeklySlot.workplace,weeklySlot.weekly_shift,weeklySlot.week_start,weeklySlot.slot,date,employeeId]);}else{await c.query('DELETE FROM holiday_plan_assignments WHERE work_date=$1::date AND workplace=$2 AND shift=$3 AND slot=$4',[date,workplace,shift,slot]);
   if(employeeId!==null||externalId!==null)await c.query('INSERT INTO holiday_plan_assignments(work_date,workplace,shift,slot,employee_id,external_id,locked) VALUES($1::date,$2,$3,$4,$5,$6,true)',[date,workplace,shift,slot,employeeId,externalId]);}
   await audit(c,req.user.id,'휴일근무 수동 배치',{date,workplace,shift,slot,before:prior||null,employee_id:employeeId,external_id:externalId});await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'해당 날짜에 이미 배치되어 있습니다.'});throw e}finally{c.release()}
 }));
 app.post('/api/holiday-plan/auto',user,admin,wrap(async(req,res)=>{const m=monthOf(req,res);if(!m)return;const c=await pool.connect();try{await c.query('BEGIN');await lock(c,m);const state=await readState(c,m),input=asPlanner(state),missing=[];for(const p of state.staff)for(const d of state.dates)if(!state.preferences.some(x=>String(x.employee_id)===String(p.id)&&x.date===d.date))missing.push({employee_id:p.id,date:d.date});if(missing.length&&!req.body.confirm_missing){await c.query('ROLLBACK');return res.status(409).json({warning:`휴일근무 미등록 ${missing.length}건이 있습니다. 미등록은 가능으로 취급하지 않습니다. 계속할까요?`,missing})}
  for(const w of state.weeklyAssignments){if(w.employee_id===null)continue;if(!input.slots.some(s=>s.id===key(w.date,w.workplace,w.shift,w.slot))||!input.staff.some(p=>String(p.id)===String(w.employee_id))){await c.query('ROLLBACK');return res.status(409).json({error:'주별 담당자의 근무 칸 또는 직원 상태를 확인하세요.'})}const conflicts=state.assignments.filter(a=>a.locked&&a.date===w.date&&(String(a.employee_id)===String(w.employee_id)||key(a.date,a.workplace,a.shift,a.slot)===key(w.date,w.workplace,w.shift,w.slot)));if(conflicts.some(a=>key(a.date,a.workplace,a.shift,a.slot)!==key(w.date,w.workplace,w.shift,w.slot)||String(a.employee_id)!==String(w.employee_id))){await c.query('ROLLBACK');return res.status(409).json({error:'주별 담당자와 고정된 휴일 배치가 충돌합니다. 배치를 확인하세요.'})}}
  const plan=planHolidays(input),lockedSlots=new Set(input.locked.map(x=>String(x.slot_id)));await c.query('DELETE FROM holiday_plan_assignments WHERE work_date >= $1::date AND work_date < ($1::date+interval \'1 month\') AND locked=false',[m+'-01']);for(const a of plan.assignments){if(lockedSlots.has(a.slot_id))continue;const [date,workplace,shift,slot]=a.slot_id.split('|'),weeklySlot=state.weeklyAssignments.find(w=>w.date===date&&w.workplace===workplace&&w.shift===shift&&Number(w.slot)===Number(slot));if(weeklySlot){if(a.type!=='staff')throw Error('주별 근무 담당자는 내부 직원이어야 합니다.');await c.query('INSERT INTO weekly_shift_overrides(workplace,shift,week_start,slot,work_date,employee_id) VALUES($1,$2,$3::date,$4,$5::date,$6) ON CONFLICT(workplace,shift,week_start,slot,work_date) DO UPDATE SET employee_id=EXCLUDED.employee_id,updated_at=now()',[workplace,weeklySlot.weekly_shift,weeklySlot.week_start,Number(slot),date,Number(a.person_id)])}else await c.query('INSERT INTO holiday_plan_assignments(work_date,workplace,shift,slot,employee_id,external_id,locked) VALUES($1::date,$2,$3,$4,$5,$6,false)',[date,workplace,shift,Number(slot),a.type==='staff'?Number(a.person_id):null,a.type==='external'?Number(a.person_id):null])}await audit(c,req.user.id,'휴일근무 자동 배치',{month:m,assigned:plan.assignments.length,shortages:plan.shortages.length,external_people:plan.externalPeople});await c.query('COMMIT');res.json({ok:true,shortages:plan.shortages,conflicts:plan.conflicts,external_people:plan.externalPeople});
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}));
};

module.exports.readState=readState;
module.exports.needFor=needFor;
module.exports.asPlanner=asPlanner;
