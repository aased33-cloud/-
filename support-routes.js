'use strict';
const {validDate}=require('./rules'),{lockPeriods}=require('./period-locks'),shiftRules=require('./shift-rules');
const holidayPlan=require('./holiday-plan-routes'),{eligibleStaff}=require('./holiday-planner');
const WORK=['하림','싱그린','정다운','동우','앤에프','중앙축산'];
module.exports=function(app,pool,user,admin,wrap){
 app.get('/api/workplace-support',user,admin,wrap(async(req,res)=>{
  const m=String(req.query.month||'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m))return res.status(400).json({error:'월을 확인하세요.'});
  const rows=(await pool.query(`SELECT s.work_date::text AS date,s.employee_id,s.workplace,s.shift,e.name,a.workplace AS base FROM daily_workplace_support s JOIN employees e ON e.id=s.employee_id LEFT JOIN monthly_workplace_assignments a ON a.employee_id=s.employee_id AND a.month=$1::date WHERE s.work_date >= $1::date AND s.work_date < ($1::date+interval '1 month') ORDER BY s.work_date,e.name`,[m+'-01'])).rows;
  res.json({items:rows});
 }));
 app.post('/api/workplace-support/swap',user,admin,wrap(async(req,res)=>{
  const date=String(req.body.date||''),ids=[Number(req.body.employee_id),Number(req.body.other_employee_id)],shifts=req.body.shifts||{};
  if(!validDate(date)||ids.some(x=>!Number.isSafeInteger(x)||x<1)||ids[0]===ids[1])return res.status(400).json({error:'교환할 날짜와 직원을 확인하세요.'});
  const month=date.slice(0,7),c=await pool.connect();try{await c.query('BEGIN');const related=[shiftRules.add(date,-7).slice(0,7),month,shiftRules.add(date,7).slice(0,7)];await lockPeriods(c,related.flatMap(m=>[`attendance:${m}`,`holiday:${m}`]));await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['monthly-workplaces-v1',month]);
   const weekday=new Date(date+'T00:00:00Z').getUTCDay();const holiday=await c.query('SELECT 1 FROM holiday_dates WHERE holiday_date=$1::date AND excluded=false',[date]);
   if(holiday.rowCount){
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['holiday-plan-v1',month]);
    const state=await holidayPlan.readState(c,month),all=[...state.assignments,...state.weeklyAssignments.filter(x=>x.employee_id!==null)].filter(x=>x.date===date),chosen=ids.map(id=>all.filter(x=>Number(x.employee_id)===id));
    if(chosen.some(x=>x.length!==1)||chosen[0][0].workplace===chosen[1][0].workplace){await c.query('ROLLBACK');return res.status(409).json({error:'같은 날짜 서로 다른 작업장의 실제 휴일 배치 두 건을 확인하세요.'})}
    const slots=chosen.map(x=>x[0]);if(slots.some(a=>all.some(b=>b!==a&&b.workplace===a.workplace&&b.shift===a.shift&&Number(b.slot)===Number(a.slot)))){await c.query('ROLLBACK');return res.status(409).json({error:'주별 담당과 휴일 배치가 중복되어 있습니다. 먼저 확인해 주세요.'})}
    const clean={...state,support:state.support.filter(x=>x.date!==date||!ids.includes(Number(x.employee_id)))},planner=holidayPlan.asPlanner(clean);
    for(let i=0;i<2;i++){
     const destination=slots[1-i],person=planner.staff.find(p=>Number(p.id)===ids[i]),target=planner.slots.find(x=>x.date===date&&x.workplace===destination.workplace&&x.kind===destination.shift&&Number(x.id.split('|').at(-1))===Number(destination.slot));
     if(!person||!target){await c.query('ROLLBACK');return res.status(409).json({error:'교환할 근무 칸과 직원을 확인하세요.'})}
     const pref=state.preferences.find(x=>x.date===date&&Number(x.employee_id)===ids[i]);
     if(destination.shift!=='야간'&&pref?.status!=='available'){
      if(req.body.confirm_unavailable!==true){await c.query('ROLLBACK');return res.status(409).json({warning:'휴일근무가 불가능하거나 미등록인 직원이 있습니다. 교환하시겠습니까?'})}
      person.availability[date].day=true;
     }
     if(!eligibleStaff(person,target)){await c.query('ROLLBACK');return res.status(409).json({error:'근태, 근무 제한 또는 휴일 야간 가능 여부 때문에 교환할 수 없습니다.'})}
    }
    for(const a of slots)if(!a.weekly)await c.query('DELETE FROM holiday_plan_assignments WHERE work_date=$1::date AND workplace=$2 AND shift=$3 AND slot=$4',[date,a.workplace,a.shift,a.slot]);
    for(let i=0;i<2;i++){
     const dest=slots[1-i],id=ids[i];
     if(dest.weekly)await c.query('INSERT INTO weekly_shift_overrides(workplace,shift,week_start,slot,work_date,employee_id) VALUES($1,$2,$3::date,$4,$5::date,$6) ON CONFLICT(workplace,shift,week_start,slot,work_date) DO UPDATE SET employee_id=EXCLUDED.employee_id,updated_at=now()',[dest.workplace,dest.weekly_shift,dest.week_start,dest.slot,date,id]);
     else await c.query('INSERT INTO holiday_plan_assignments(work_date,workplace,shift,slot,employee_id,external_id,locked) VALUES($1::date,$2,$3,$4,$5,NULL,true)',[date,dest.workplace,dest.shift,dest.slot,id]);
     const person=state.staff.find(x=>Number(x.id)===id);if(person.base===dest.workplace)await c.query('DELETE FROM daily_workplace_support WHERE work_date=$1::date AND employee_id=$2',[date,id]);
     else await c.query('INSERT INTO daily_workplace_support(work_date,employee_id,workplace,shift) VALUES($1::date,$2,$3,$4) ON CONFLICT(work_date,employee_id) DO UPDATE SET workplace=EXCLUDED.workplace,shift=EXCLUDED.shift,updated_at=now()',[date,id,dest.workplace,dest.workplace==='싱그린'?dest.shift:null]);
    }
    await c.query('INSERT INTO audit_log(actor_id,action,before_data,after_data) VALUES($1,$2,$3,$4)',[req.user.id,'휴일 근무자 교환',JSON.stringify({date,slots}),JSON.stringify({date,employee_ids:ids})]);await c.query('COMMIT');return res.json({ok:true});
   }
   if(weekday===0||weekday===6){await c.query('ROLLBACK');return res.status(409).json({error:'등록되지 않은 주말은 교환할 수 없습니다.'})}
   const people=(await c.query(`SELECT e.id,a.workplace AS base FROM employees e JOIN monthly_workplace_assignments a ON a.employee_id=e.id AND a.month=$1::date WHERE e.active=true AND e.id=ANY($2::bigint[])`,[month+'-01',ids])).rows;
   if(people.length!==2){await c.query('ROLLBACK');return res.status(409).json({error:'서로 다른 기본 작업장의 활성 직원을 선택하세요.'})}
   const actual=await c.query('SELECT employee_id,workplace,shift FROM daily_workplace_support WHERE work_date=$1::date AND employee_id=ANY($2::bigint[])',[date,ids]);
   const attendance=await c.query('SELECT employee_id FROM attendance WHERE employee_id=ANY($1::bigint[]) AND start_date<=$2::date AND end_date>=$2::date AND type<>$3',[ids,date,'외출']);
   const weekly=(await c.query(`SELECT w.workplace,w.shift,w.week_start::text AS week_start,w.slot,CASE WHEN o.work_date IS NULL THEN w.employee_id ELSE o.employee_id END AS employee_id FROM weekly_shift_assignments w LEFT JOIN weekly_shift_overrides o ON o.workplace=w.workplace AND o.shift=w.shift AND o.week_start=w.week_start AND o.slot=w.slot AND o.work_date=$1::date WHERE w.week_start <= $1::date AND w.week_start >= ($1::date-interval '6 days')`,[date])).rows.filter(w=>ids.includes(Number(w.employee_id))&&shiftRules.shiftSpec(w.workplace,w.shift)&&date<=shiftRules.add(w.week_start,shiftRules.shiftSpec(w.workplace,w.shift).days-1));
   if(ids.some(id=>weekly.filter(w=>Number(w.employee_id)===id).length>1)||weekly.some(w=>actual.rows.some(x=>Number(x.employee_id)===Number(w.employee_id)&&x.workplace!==w.workplace))){await c.query('ROLLBACK');return res.status(409).json({error:'기존 지원 또는 중복 배치를 먼저 확인해 주세요.'})}
   if(attendance.rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'선택한 직원에게 해당 날짜 근태가 있습니다. 일정을 확인해 주세요.'})}
   const positions=people.map(p=>{const w=weekly.find(x=>Number(x.employee_id)===Number(p.id)),support=actual.rows.find(x=>Number(x.employee_id)===Number(p.id));return {person:p,weekly:w,support,workplace:w?.workplace||support?.workplace||p.base}});
   if(positions[0].workplace===positions[1].workplace){await c.query('ROLLBACK');return res.status(409).json({error:'서로 다른 작업장에서 근무 중인 직원을 선택하세요.'})}
   for(const {person,weekly:from} of positions){
    const dest=positions.find(x=>Number(x.person.id)!==Number(person.id)),w=dest.weekly;
    if(w){const spec=shiftRules.shiftSpec(w.workplace,w.shift),end=shiftRules.add(w.week_start,spec.days-1),periodAttendance=(await c.query('SELECT type,start_date::text AS start_date,end_date::text AS end_date FROM attendance WHERE employee_id=$1 AND start_date<=$3::date AND end_date>=$2::date',[person.id,w.week_start,end])).rows;
     const restriction=(await c.query('SELECT 1 FROM employee_shift_restrictions WHERE employee_id=$1 AND restriction=$2',[person.id,w.workplace+w.shift])).rowCount;
     if(restriction){await c.query('ROLLBACK');return res.status(409).json({error:'근무 제한으로 교환할 수 없습니다.'})}
     if(w.shift==='야간'){
      const blocked=(await c.query('SELECT 1 FROM employee_night_exclusions WHERE employee_id=$1 AND blocked=true',[person.id])).rowCount,off=(await c.query('SELECT 1 FROM night_unavailable_weeks WHERE employee_id=$1 AND workplace=$2 AND week_start=$3::date',[person.id,w.workplace,w.week_start])).rowCount;
      if(blocked||off||!shiftRules.inNightPool(person.base,w.workplace)||shiftRules.hasAttendance(periodAttendance,w.week_start,end,true)){await c.query('ROLLBACK');return res.status(409).json({error:'야간 가능 여부나 해당 주 근태 때문에 교환할 수 없습니다.'})}
     }
    }
   }
   await c.query('DELETE FROM daily_workplace_support WHERE work_date=$1::date AND employee_id=ANY($2::bigint[])',[date,ids]);
   for(const {person,weekly:from} of positions){const dest=positions.find(x=>Number(x.person.id)!==Number(person.id));if(dest.weekly){const w=dest.weekly;await c.query('INSERT INTO weekly_shift_overrides(workplace,shift,week_start,slot,work_date,employee_id) VALUES($1,$2,$3::date,$4,$5::date,$6) ON CONFLICT(workplace,shift,week_start,slot,work_date) DO UPDATE SET employee_id=EXCLUDED.employee_id,updated_at=now()',[w.workplace,w.shift,w.week_start,w.slot,date,person.id])}
    if(dest.workplace!==person.base){const shift=dest.workplace==='싱그린'?(dest.weekly?.shift||dest.support?.shift||String(shifts[dest.person.id]||'')):null;if(dest.workplace==='싱그린'&&!['조출','후출'].includes(shift)){await c.query('ROLLBACK');return res.status(400).json({error:'싱그린 근무시간을 확인하세요.'})}await c.query('INSERT INTO daily_workplace_support(work_date,employee_id,workplace,shift) VALUES($1::date,$2,$3,$4)',[date,person.id,dest.workplace,shift])}
   }
   await c.query('INSERT INTO audit_log(actor_id,action,after_data) VALUES($1,$2,$3)',[req.user.id,'근무자 교환',JSON.stringify({date,employee_ids:ids,positions:positions.map(p=>({employee_id:p.person.id,base:p.person.base,workplace:p.workplace,shift:p.weekly?.shift||p.support?.shift||null})),shifts})]);await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 app.put('/api/workplace-support',user,admin,wrap(async(req,res)=>{
  const replaceId=req.body.replace_employee_id==null?null:Number(req.body.replace_employee_id);if(replaceId!==null&&(!Number.isSafeInteger(replaceId)||replaceId<1))return res.status(400).json({error:'기존 지원자를 확인하세요.'});
  const date=String(req.body.date||''),id=Number(req.body.employee_id),workplace=req.body.workplace===null?null:String(req.body.workplace||''),shift=workplace==='싱그린'&&req.body.shift?String(req.body.shift):null;if(shift!==null&&!['조출','후출'].includes(shift))return res.status(400).json({error:'싱그린 지원 근무시간을 확인하세요.'});if(!validDate(date)||!Number.isSafeInteger(id)||id<1||(workplace!==null&&!WORK.includes(workplace)))return res.status(400).json({error:'날짜, 직원, 지원 작업장을 확인하세요.'});const month=date.slice(0,7),c=await pool.connect();
  try{await c.query('BEGIN');await lockPeriods(c,[`attendance:${month}`,`holiday:${month}`]);await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['monthly-workplaces-v1',month]);
   const p=(await c.query('SELECT e.id,a.workplace AS base FROM employees e LEFT JOIN monthly_workplace_assignments a ON a.employee_id=e.id AND a.month=$2::date WHERE e.id=$1 AND e.active=true',[id,month+'-01'])).rows[0];if(!p||!p.base){await c.query('ROLLBACK');return res.status(409).json({error:'활성 직원의 해당 월 기본 작업장을 먼저 지정하세요.'})}if(workplace===p.base){await c.query('ROLLBACK');return res.status(400).json({error:'기본 작업장과 다른 지원 작업장을 선택하세요.'})}
   const before=(await c.query('SELECT workplace,shift FROM daily_workplace_support WHERE work_date=$1::date AND employee_id=$2',[date,id])).rows[0]||null;
   let replaced=null;if(replaceId!==null&&replaceId!==id){
    if(!workplace){await c.query('ROLLBACK');return res.status(400).json({error:'변경할 지원 작업장을 확인하세요.'})}
    replaced=(await c.query('SELECT workplace,shift FROM daily_workplace_support WHERE work_date=$1::date AND employee_id=$2',[date,replaceId])).rows[0];
    if(!replaced||replaced.workplace!==workplace||replaced.shift!==shift){await c.query('ROLLBACK');return res.status(409).json({error:'기존 지원이 변경됐습니다. 화면을 새로고침해 주세요.'})}
    if(before){await c.query('ROLLBACK');return res.status(409).json({error:'새 지원자는 해당 날짜에 이미 다른 지원을 하고 있습니다.'})}
    const holiday=await c.query('SELECT 1 FROM holiday_dates WHERE holiday_date=$1::date AND excluded=false',[date]);
    if(holiday.rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'휴일 지원 변경은 휴일근무 배치에서 확인해 주세요.'})}
    if((await c.query('SELECT 1 FROM attendance WHERE employee_id=$1 AND start_date<=$2::date AND end_date>=$2::date AND type<>$3 LIMIT 1',[id,date,'외출'])).rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'새 지원자에게 해당 날짜의 근태가 있습니다.'})}
   }

   if(workplace){const assigned=(await c.query('SELECT workplace,shift FROM holiday_plan_assignments WHERE work_date=$1::date AND employee_id=$2',[date,id])).rows[0];if(assigned&&assigned.workplace!==workplace){await c.query('ROLLBACK');return res.status(409).json({error:'이미 배정된 휴일 작업장과 다릅니다. 휴일 배치를 먼저 확인하세요.'})}
    if(shift&&assigned&&assigned.shift!==shift){await c.query('ROLLBACK');return res.status(409).json({error:'휴일 배치에 지정된 근무시간과 다릅니다. 휴일 배치를 먼저 확인하세요.'})}
    const weekly=(await c.query(`SELECT w.workplace,w.shift,w.week_start::text AS week_start,CASE WHEN o.work_date IS NULL THEN w.employee_id ELSE o.employee_id END AS employee_id FROM weekly_shift_assignments w LEFT JOIN weekly_shift_overrides o ON o.workplace=w.workplace AND o.shift=w.shift AND o.week_start=w.week_start AND o.slot=w.slot AND o.work_date=$1::date WHERE w.week_start <= $1::date AND w.week_start >= ($1::date-interval '6 days')`,[date])).rows;
    if(replaced&&weekly.some(w=>Number(w.employee_id)===replaceId&&date<=shiftRules.add(w.week_start,shiftRules.shiftSpec(w.workplace,w.shift).days-1))){await c.query('ROLLBACK');return res.status(409).json({error:'기존 지원자가 주별 담당으로 지정되어 있어 먼저 날짜별 담당을 확인해 주세요.'})}
    if(weekly.some(w=>String(w.employee_id)===String(id)&&w.workplace!==workplace&&date<=shiftRules.add(w.week_start,shiftRules.shiftSpec(w.workplace,w.shift).days-1))){await c.query('ROLLBACK');return res.status(409).json({error:'해당 날짜의 주별 담당 작업장과 다릅니다. 담당자를 먼저 확인하세요.'})}
    if(shift&&weekly.some(w=>String(w.employee_id)===String(id)&&w.workplace===workplace&&w.shift!==shift&&date<=shiftRules.add(w.week_start,shiftRules.shiftSpec(w.workplace,w.shift).days-1))){await c.query('ROLLBACK');return res.status(409).json({error:'주별 담당에 지정된 근무시간과 다릅니다. 주별 담당자를 먼저 확인하세요.'})}
    await c.query('INSERT INTO daily_workplace_support(work_date,employee_id,workplace,shift) VALUES($1::date,$2,$3,$4) ON CONFLICT(work_date,employee_id) DO UPDATE SET workplace=EXCLUDED.workplace,shift=EXCLUDED.shift,updated_at=now()',[date,id,workplace,shift]);
    if(replaced)await c.query('DELETE FROM daily_workplace_support WHERE work_date=$1::date AND employee_id=$2',[date,replaceId]);
   }else await c.query('DELETE FROM daily_workplace_support WHERE work_date=$1::date AND employee_id=$2',[date,id]);
   if(replaced)await c.query('INSERT INTO audit_log(actor_id,action,before_data,after_data) VALUES($1,$2,$3,$4)',[req.user.id,'지원자 변경',JSON.stringify({date,employee_id:replaceId,workplace,shift}),JSON.stringify({date,employee_id:id,workplace,shift})]);
   await c.query('INSERT INTO audit_log(actor_id,action,before_data,after_data) VALUES($1,$2,$3,$4)',[req.user.id,'날짜별 작업장 지원 변경',JSON.stringify({date,employee_id:id,workplace:before?.workplace||null,shift:before?.shift||null}),JSON.stringify({date,employee_id:id,workplace,shift})]);await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
};
