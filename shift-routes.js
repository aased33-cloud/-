'use strict';
const R=require('./shift-rules');
const {lockPeriods}=require('./period-locks');
const {months}=require('./rules');
const monthOK=m=>/^\d{4}-(0[1-9]|1[0-2])$/.test(m||'');
const previous=m=>{const [y,n]=m.split('-').map(Number);return new Date(Date.UTC(y,n-2,1)).toISOString().slice(0,7)};
function selected(req,res){const month=String(req.query.month||req.body?.month||''),workplace=String(req.query.workplace||req.body?.workplace||''),shift=String(req.query.shift||req.body?.shift||''),start=String(req.query.week_start||req.body?.week_start||''),spec=R.shiftSpec(workplace,shift);if(!monthOK(month)||!spec||!R.weeks(month,workplace,shift).some(w=>w.start===start)){res.status(400).json({error:'월과 근무 주간을 확인하세요.'});return null}return {month,workplace,shift,start,end:R.add(start,spec.days-1),spec}}
async function candidates(c,q){
 const people=(await c.query(`SELECT e.id,e.name,e.employee_no,a.workplace AS base,COALESCE(n.blocked,false) AS night_blocked FROM employees e LEFT JOIN monthly_workplace_assignments a ON a.employee_id=e.id AND a.month=$1::date LEFT JOIN employee_night_exclusions n ON n.employee_id=e.id WHERE e.active=true ORDER BY e.name,e.employee_no`,[q.month+'-01'])).rows;
 const attend=(await c.query(`SELECT employee_id,type,start_date::text AS start_date,end_date::text AS end_date FROM attendance WHERE start_date <= $2::date AND end_date >= $1::date`,[q.start,q.end])).rows;
 const off=q.shift==='야간'?(await c.query('SELECT employee_id FROM night_unavailable_weeks WHERE workplace=$1 AND week_start=$2::date',[q.workplace,q.start])).rows:[];
 const restriction=q.workplace+q.shift,restrictions=(await c.query('SELECT employee_id FROM employee_shift_restrictions WHERE restriction=$1',[restriction])).rows;
 const assigned=(await c.query(`SELECT employee_id,workplace,shift,week_start::text AS week_start,slot FROM weekly_shift_assignments WHERE week_start >= ($1::date-interval '6 days') AND week_start <= $2::date`,[q.start,q.end])).rows;
 return people.map(p=>{
  const id=String(p.id),items=attend.filter(x=>String(x.employee_id)===id),unavailable=R.hasAttendance(items,q.start,q.end,q.shift==='야간'),reasons=[];
  if(q.shift==='야간'){
   if(!R.inNightPool(p.base,q.workplace))reasons.push('기본 작업장 기준 제외');
   if(p.night_blocked)reasons.push('관리자 야간 불가');
   if(off.some(x=>String(x.employee_id)===id))reasons.push('불가능 주간 등록');
   if(unavailable)reasons.push('해당 주 평일 근태');
  }else if(restrictions.some(x=>String(x.employee_id)===id))reasons.push('관리자 근무 불가');
  const overlaps=assigned.filter(x=>String(x.employee_id)===id&&!(x.workplace===q.workplace&&x.shift===q.shift&&x.week_start===q.start));
  if(overlaps.some(x=>{const spec=R.shiftSpec(x.workplace,x.shift);return spec&&x.week_start<=q.end&&R.add(x.week_start,spec.days-1)>=q.start}))reasons.push('다른 주별 근무와 중복');
  return {id:p.id,name:p.name,employee_no:p.employee_no,base:p.base,attendance:q.shift!=='야간'&&unavailable,reasons};
 }).sort((a,b)=>a.reasons.length-b.reasons.length||Number(a.attendance)-Number(b.attendance)||Number(b.base===q.workplace)-Number(a.base===q.workplace)||a.name.localeCompare(b.name,'ko'));
}
module.exports=function attachShifts(app,pool,user,admin,wrap){
 app.get('/api/weekly-shift/weeks',user,admin,wrap(async(req,res)=>{
  const month=String(req.query.month||'');if(!monthOK(month))return res.status(400).json({error:'월을 확인하세요.'});
  const options=[['하림','조출'],['하림','야간'],['동우','후출'],['동우','야간'],['싱그린','조출'],['싱그린','후출']];
  res.json(options.map(([workplace,shift])=>({workplace,shift,slots:R.shiftSpec(workplace,shift).slots,weeks:R.weeks(month,workplace,shift)})));
 }));
 app.get('/api/weekly-shift',user,admin,wrap(async(req,res)=>{
  const q=selected(req,res);if(!q)return;const rows=(await pool.query('SELECT slot,employee_id FROM weekly_shift_assignments WHERE workplace=$1 AND shift=$2 AND week_start=$3::date ORDER BY slot',[q.workplace,q.shift,q.start])).rows;
  const counts=(await pool.query(`SELECT employee_id,week_start::text AS week_start FROM weekly_shift_assignments WHERE workplace=$1 AND shift=$2 AND week_start >= ($3::date-interval '7 days') AND week_start < ($4::date+interval '1 month')`,[q.workplace,q.shift,previous(q.month)+'-01',q.month+'-01'])).rows;
  const people=await candidates(pool,q);for(const p of people){p.previous_count=0;p.current_count=0;for(const x of counts.filter(x=>String(x.employee_id)===String(p.id))){const m=R.countMonth(x.week_start);if(m===q.month)p.current_count++;if(m===previous(q.month))p.previous_count++}}
  res.json({week:q.start,end:q.end,assignments:rows,candidates:people});
 }));
 app.put('/api/weekly-shift',user,admin,wrap(async(req,res)=>{
  const q=selected(req,res);if(!q)return;const slot=Number(req.body.slot),id=req.body.employee_id===null?null:Number(req.body.employee_id);
  if(!Number.isSafeInteger(slot)||slot<1||slot>q.spec.slots||(id!==null&&(!Number.isSafeInteger(id)||id<1)))return res.status(400).json({error:'담당자 또는 근무 칸을 확인하세요.'});
  const c=await pool.connect();try{await c.query('BEGIN');await lockPeriods(c,months(q.start,q.end).map(m=>`attendance:${m}`));
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['monthly-workplaces-v1',q.month]);
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['weekly-shifts-v1',q.start]);
   if(id!==null){await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['shift-restrictions-v1',String(id)]);await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['night-exclusions-v1',String(id)])}
   if(id!==null){const person=(await candidates(c,q)).find(p=>Number(p.id)===id);if(!person||person.reasons.length){await c.query('ROLLBACK');return res.status(409).json({error:'현재 선택할 수 없는 직원입니다.'})}
    const existing=(await c.query('SELECT slot FROM weekly_shift_assignments WHERE workplace=$1 AND shift=$2 AND week_start=$3::date AND employee_id=$4',[q.workplace,q.shift,q.start,id])).rows[0];if(existing&&Number(existing.slot)!==slot){await c.query('ROLLBACK');return res.status(409).json({error:'같은 주의 다른 칸에 이미 배치되어 있습니다.'})}}
   const old=(await c.query('SELECT employee_id FROM weekly_shift_assignments WHERE workplace=$1 AND shift=$2 AND week_start=$3::date AND slot=$4',[q.workplace,q.shift,q.start,slot])).rows[0]?.employee_id||null;
   if(String(old??'')===String(id??'')){await c.query('COMMIT');return res.json({ok:true,unchanged:true})}
   if(id===null)await c.query('DELETE FROM weekly_shift_assignments WHERE workplace=$1 AND shift=$2 AND week_start=$3::date AND slot=$4',[q.workplace,q.shift,q.start,slot]);
   else await c.query('INSERT INTO weekly_shift_assignments(workplace,shift,week_start,slot,employee_id) VALUES($1,$2,$3::date,$4,$5) ON CONFLICT(workplace,shift,week_start,slot) DO UPDATE SET employee_id=EXCLUDED.employee_id,updated_at=now()',[q.workplace,q.shift,q.start,slot,id]);
   await c.query('INSERT INTO audit_log(actor_id,action,before_data,after_data) VALUES($1,$2,$3,$4)',[req.user.id,'주별 담당자 변경',JSON.stringify({workplace:q.workplace,shift:q.shift,week_start:q.start,slot,employee_id:old}),JSON.stringify({workplace:q.workplace,shift:q.shift,week_start:q.start,slot,employee_id:id})]);
   await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
};
