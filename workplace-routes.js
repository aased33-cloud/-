'use strict';
const {seoulDate,validDate,months}=require('./rules');
const {lockPeriods}=require('./period-locks');
const WORKPLACES=['하림','싱그린','정다운','동우','앤에프','중앙축산'];
const monthOK=m=>/^\d{4}-(0[1-9]|1[0-2])$/.test(m||'');
function nightWeeks(month,workplace){
 const [y,m]=month.split('-').map(Number),first=new Date(Date.UTC(y,m-1,1)),last=new Date(Date.UTC(y,m,0));
 const startDay=workplace==='동우'?0:1,offset=(first.getUTCDay()-startDay+7)%7;
 let day=new Date(Date.UTC(y,m-1,1-offset));const out=[];
 while(day<=last){const end=new Date(day);end.setUTCDate(end.getUTCDate()+5);if(end>=first)out.push({start:day.toISOString().slice(0,10),end:end.toISOString().slice(0,10)});day.setUTCDate(day.getUTCDate()+7)}
 return out;
}
function previousMonth(month){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,7)}
module.exports=function attachWorkplaces(app,pool,user,admin,wrap){
 const validateMonth=(req,res)=>{const m=String(req.query.month||req.body?.month||'');if(!monthOK(m)){res.status(400).json({error:'월을 확인하세요.'});return null}return m};
 const lock=async(c,m)=>c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['monthly-workplaces-v1',m]);
 async function registrationOpen(c,req,month){
  if(req.user.role==='admin')return true;
  const p=(await c.query("SELECT start_date::text s,deadline_date::text d FROM monthly_deadlines WHERE kind='attendance' AND month=$1::date",[month+'-01'])).rows[0];
  return !!p?.s&&seoulDate()>=p.s&&seoulDate()<=p.d;
 }
 async function nightContext(c,employeeId,month){
  const a=(await c.query('SELECT workplace FROM monthly_workplace_assignments WHERE month=$1::date AND employee_id=$2',[month+'-01',employeeId])).rows[0];
  const blocked=(await c.query('SELECT blocked FROM employee_night_exclusions WHERE employee_id=$1',[employeeId])).rows[0]?.blocked||false;
  const workplace=a?.workplace?(a.workplace==='동우'||a.workplace==='앤에프'?'동우':'하림'):null;
  return {workplace,blocked};
 }
 app.get('/api/night-exclusions',user,admin,wrap(async(req,res)=>{const r=await pool.query('SELECT employee_id FROM employee_night_exclusions WHERE blocked=true');res.json(r.rows)}));
 app.get('/api/shift-restrictions',user,admin,wrap(async(req,res)=>{const r=await pool.query('SELECT employee_id,restriction FROM employee_shift_restrictions');res.json(r.rows)}));
 app.put('/api/shift-restrictions/:employeeId',user,admin,wrap(async(req,res)=>{
  const id=Number(req.params.employeeId),restriction=String(req.body.restriction||''),blocked=req.body.blocked;
  if(!Number.isSafeInteger(id)||id<1||!['하림조출','동우후출'].includes(restriction)||typeof blocked!=='boolean')return res.status(400).json({error:'직원과 설정을 확인하세요.'});
  const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['shift-restrictions-v1',String(id)]);
   if(!(await c.query('SELECT id FROM employees WHERE id=$1 AND active=true',[id])).rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'활성 직원을 선택하세요.'})}
   const old=!!(await c.query('SELECT 1 FROM employee_shift_restrictions WHERE employee_id=$1 AND restriction=$2',[id,restriction])).rowCount;
   if(blocked)await c.query('INSERT INTO employee_shift_restrictions(employee_id,restriction) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,restriction]);else await c.query('DELETE FROM employee_shift_restrictions WHERE employee_id=$1 AND restriction=$2',[id,restriction]);
   if(old!==blocked)await c.query('INSERT INTO audit_log(actor_id,action,record_id,before_data,after_data) VALUES($1,$2,$3,$4,$5)',[req.user.id,'근무 제한 변경',id,JSON.stringify({restriction,blocked:old}),JSON.stringify({restriction,blocked})]);
   await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 app.put('/api/night-exclusions/:employeeId',user,admin,wrap(async(req,res)=>{
  const id=Number(req.params.employeeId),blocked=req.body.blocked;if(!Number.isSafeInteger(id)||id<1||typeof blocked!=='boolean')return res.status(400).json({error:'직원과 설정을 확인하세요.'});
  const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",['night-exclusions-v1',String(id)]);
   if(!(await c.query('SELECT id FROM employees WHERE id=$1 AND active=true',[id])).rowCount){await c.query('ROLLBACK');return res.status(400).json({error:'활성 직원을 선택하세요.'})}
   const old=(await c.query('SELECT blocked FROM employee_night_exclusions WHERE employee_id=$1',[id])).rows[0]?.blocked||false;
   if(old!==blocked){await c.query('INSERT INTO employee_night_exclusions(employee_id,blocked) VALUES($1,$2) ON CONFLICT(employee_id) DO UPDATE SET blocked=EXCLUDED.blocked,updated_at=now()',[id,blocked]);await c.query('INSERT INTO audit_log(actor_id,action,record_id,before_data,after_data) VALUES($1,$2,$3,$4,$5)',[req.user.id,'야간 가능 설정 변경',id,JSON.stringify({blocked:old}),JSON.stringify({blocked})])}
   await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 app.get('/api/night-registration',user,wrap(async(req,res)=>{
  const month=validateMonth(req,res);if(!month)return;const context=await nightContext(pool,req.user.id,month);
  if(!context.workplace||context.blocked)return res.json({month,...context,weeks:[],confirmed:false});
  const windows=nightWeeks(month,context.workplace),keys=windows.map(w=>w.start),selected=(await pool.query('SELECT week_start::text AS week_start FROM night_unavailable_weeks WHERE employee_id=$1 AND workplace=$2 AND week_start=ANY($3::date[])',[req.user.id,context.workplace,keys])).rows;
  const confirmed=(await pool.query('SELECT night_confirmed FROM attendance_registration_progress WHERE month=$1::date AND employee_id=$2',[month+'-01',req.user.id])).rows[0]?.night_confirmed||false;
  res.json({month,...context,confirmed,weeks:windows.map(w=>({...w,unavailable:selected.some(x=>x.week_start===w.start)}))});
 }));
 app.put('/api/night-registration',user,wrap(async(req,res)=>{
  const month=validateMonth(req,res);if(!month)return;const week=String(req.body.week_start||''),unavailable=req.body.unavailable,confirm=req.body.confirm===true;
  if(!confirm&&(typeof unavailable!=='boolean'||!validDate(week)))return res.status(400).json({error:'야간 불가능 주간을 확인하세요.'});
  const weekEnd=confirm?null:new Date(Date.parse(week+'T00:00:00Z')+5*86400000).toISOString().slice(0,10);
  const affectedMonths=confirm?[month]:months(week,weekEnd);
  const c=await pool.connect();try{await c.query('BEGIN');await lockPeriods(c,[`attendance:${month}`,...affectedMonths.map(m=>`attendance:${m}`)]);
   if(!await registrationOpen(c,req,month)){await c.query('ROLLBACK');return res.status(403).json({error:'근태 등록 기간이 아닙니다.'})}
   const ctx=await nightContext(c,req.user.id,month);if(!ctx.workplace||ctx.blocked){await c.query('ROLLBACK');return res.status(403).json({error:'야간 등록 대상이 아닙니다.'})}
   if(!confirm){if(!nightWeeks(month,ctx.workplace).some(w=>w.start===week)){await c.query('ROLLBACK');return res.status(400).json({error:'주간 날짜를 확인하세요.'})}
    const previous=!!(await c.query('SELECT 1 FROM night_unavailable_weeks WHERE employee_id=$1 AND workplace=$2 AND week_start=$3::date',[req.user.id,ctx.workplace,week])).rowCount;
    if(unavailable)await c.query('INSERT INTO night_unavailable_weeks(employee_id,workplace,week_start) VALUES($1,$2,$3::date) ON CONFLICT DO NOTHING',[req.user.id,ctx.workplace,week]);
    else await c.query('DELETE FROM night_unavailable_weeks WHERE employee_id=$1 AND workplace=$2 AND week_start=$3::date',[req.user.id,ctx.workplace,week]);
    if(previous!==unavailable){
     await c.query('UPDATE attendance_registration_progress SET night_confirmed=false,updated_at=now() WHERE employee_id=$1 AND month=ANY($2::date[])',[req.user.id,affectedMonths.map(m=>m+'-01')]);
     await c.query('INSERT INTO audit_log(actor_id,action,before_data,after_data) VALUES($1,$2,$3,$4)',[req.user.id,'야간 불가능 주간 변경',JSON.stringify({workplace:ctx.workplace,week_start:week,unavailable:previous}),JSON.stringify({workplace:ctx.workplace,week_start:week,unavailable})]);
    }
   }
   await c.query('INSERT INTO attendance_registration_progress(month,employee_id,night_confirmed) VALUES($1::date,$2,$3) ON CONFLICT(month,employee_id) DO UPDATE SET night_confirmed=EXCLUDED.night_confirmed,updated_at=now()',[month+'-01',req.user.id,confirm]);
   await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 app.get('/api/workplaces',user,admin,wrap(async(req,res)=>{
  const month=validateMonth(req,res);if(!month)return;
  const {rows}=await pool.query(`SELECT a.employee_id,a.workplace,e.name,e.employee_no,e.active FROM monthly_workplace_assignments a JOIN employees e ON e.id=a.employee_id WHERE a.month=$1::date ORDER BY e.name,e.employee_no`,[month+'-01']);res.json({month,assignments:rows});
 }));
 app.get('/api/my-workplace',user,wrap(async(req,res)=>{
  const month=validateMonth(req,res);if(!month)return;
  const {rows}=await pool.query('SELECT workplace FROM monthly_workplace_assignments WHERE month=$1::date AND employee_id=$2',[month+'-01',req.user.id]);res.json({month,workplace:rows[0]?.workplace||null});
 }));
 app.get('/api/registration-attendance',user,wrap(async(req,res)=>{
  const month=validateMonth(req,res);if(!month)return;
  const r=await pool.query(`SELECT a.id,a.type,to_char(a.start_date,'YYYY-MM-DD') AS start_date,to_char(a.end_date,'YYYY-MM-DD') AS end_date,to_char(a.start_time,'HH24:MI') AS start_time,to_char(a.end_time,'HH24:MI') AS end_time,a.note FROM attendance a WHERE a.employee_id=$1 AND a.start_date < ($2::date+interval '1 month') AND a.end_date >= $2::date ORDER BY a.start_date,a.id`,[req.user.id,month+'-01']);
  const progress=await pool.query('SELECT no_attendance FROM attendance_registration_progress WHERE employee_id=$1 AND month=$2::date',[req.user.id,month+'-01']);
  res.json({month,items:r.rows,no_attendance:!r.rows.length&&!!progress.rows[0]?.no_attendance});
 }));
 app.put('/api/registration-attendance/none',user,wrap(async(req,res)=>{
  const month=validateMonth(req,res);if(!month)return;
  const c=await pool.connect();try{
   await c.query('BEGIN');await lockPeriods(c,[`attendance:${month}`]);
   if(req.user.role!=='admin'){
    const period=(await c.query("SELECT start_date::text AS s,deadline_date::text AS d FROM monthly_deadlines WHERE kind='attendance' AND month=$1::date",[month+'-01'])).rows[0];
    if(!period?.s||seoulDate()<period.s||seoulDate()>period.d){await c.query('ROLLBACK');return res.status(403).json({error:'근태 등록 기간이 아닙니다.'})}
   }
   const existing=await c.query("SELECT 1 FROM attendance WHERE employee_id=$1 AND start_date < ($2::date+interval '1 month') AND end_date >= $2::date LIMIT 1",[req.user.id,month+'-01']);
   if(existing.rowCount){await c.query('ROLLBACK');return res.status(409).json({error:'이미 등록된 근태 일정이 있습니다.'})}
   await c.query('INSERT INTO attendance_registration_progress(month,employee_id,no_attendance) VALUES($1::date,$2,true) ON CONFLICT(month,employee_id) DO UPDATE SET no_attendance=true,updated_at=now()',[month+'-01',req.user.id]);
   await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 app.put('/api/workplaces/:employeeId',user,admin,wrap(async(req,res)=>{
  const month=validateMonth(req,res);if(!month)return;
  const id=Number(req.params.employeeId),workplace=req.body.workplace;
  if(!Number.isSafeInteger(id)||id<1||!(workplace===null||WORKPLACES.includes(workplace)))return res.status(400).json({error:'직원과 작업장을 확인하세요.'});
  const c=await pool.connect();try{
   await c.query('BEGIN');await lock(c,month);
   const employee=await c.query('SELECT id,active FROM employees WHERE id=$1',[id]);
   if(!employee.rowCount||!employee.rows[0].active){await c.query('ROLLBACK');return res.status(400).json({error:'활성 직원을 선택하세요.'})}
   const old=(await c.query('SELECT workplace FROM monthly_workplace_assignments WHERE month=$1::date AND employee_id=$2',[month+'-01',id])).rows[0]?.workplace||null;
   if(old===workplace){await c.query('COMMIT');return res.json({ok:true,unchanged:true})}
   if(workplace===null)await c.query('DELETE FROM monthly_workplace_assignments WHERE month=$1::date AND employee_id=$2',[month+'-01',id]);
   else await c.query('INSERT INTO monthly_workplace_assignments(month,employee_id,workplace) VALUES($1::date,$2,$3) ON CONFLICT(month,employee_id) DO UPDATE SET workplace=EXCLUDED.workplace,updated_at=now()',[month+'-01',id,workplace]);
   await c.query('INSERT INTO audit_log(actor_id,action,record_id,before_data,after_data) VALUES($1,$2,$3,$4,$5)',[req.user.id,'작업장 기본 배치 변경',id,JSON.stringify({month,employee_id:id,workplace:old}),JSON.stringify({month,employee_id:id,workplace})]);
   await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
 app.post('/api/workplaces/copy-previous',user,admin,wrap(async(req,res)=>{
  const month=validateMonth(req,res);if(!month)return;const prev=previousMonth(month),c=await pool.connect();try{
   await c.query('BEGIN');await lock(c,month);
   const result=await c.query(`INSERT INTO monthly_workplace_assignments(month,employee_id,workplace) SELECT $1::date,a.employee_id,a.workplace FROM monthly_workplace_assignments a JOIN employees e ON e.id=a.employee_id WHERE a.month=$2::date AND e.active=true ON CONFLICT(month,employee_id) DO NOTHING RETURNING employee_id,workplace`,[month+'-01',prev+'-01']);
   if(result.rowCount)await c.query('INSERT INTO audit_log(actor_id,action,after_data) VALUES($1,$2,$3)',[req.user.id,'이전 달 작업장 배치 불러오기',JSON.stringify({month,source_month:prev,assignments:result.rows})]);
   await c.query('COMMIT');res.json({ok:true,copied:result.rowCount,source_month:prev});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
};
