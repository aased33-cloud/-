'use strict';
const {seoulDate}=require('./rules');
const {lockPeriods}=require('./period-locks');
const WORKPLACES=['하림','싱그린','정다운','동우','앤에프','중앙축산'];
const monthOK=m=>/^\d{4}-(0[1-9]|1[0-2])$/.test(m||'');
function previousMonth(month){const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-2,1)).toISOString().slice(0,7)}
module.exports=function attachWorkplaces(app,pool,user,admin,wrap){
 const validateMonth=(req,res)=>{const m=String(req.query.month||req.body?.month||'');if(!monthOK(m)){res.status(400).json({error:'월을 확인하세요.'});return null}return m};
 const lock=async(c,m)=>c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['monthly-workplaces-v1',m]);
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
