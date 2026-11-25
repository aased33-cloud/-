'use strict';
const {validDate}=require('./rules'),{lockPeriods}=require('./period-locks'),shiftRules=require('./shift-rules');
const WORK=['하림','싱그린','정다운','동우','앤에프','중앙축산'];
module.exports=function(app,pool,user,admin,wrap){
 app.get('/api/workplace-support',user,admin,wrap(async(req,res)=>{
  const m=String(req.query.month||'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m))return res.status(400).json({error:'월을 확인하세요.'});
  const rows=(await pool.query(`SELECT s.work_date::text AS date,s.employee_id,s.workplace,e.name,a.workplace AS base FROM daily_workplace_support s JOIN employees e ON e.id=s.employee_id LEFT JOIN monthly_workplace_assignments a ON a.employee_id=s.employee_id AND a.month=$1::date WHERE s.work_date >= $1::date AND s.work_date < ($1::date+interval '1 month') ORDER BY s.work_date,e.name`,[m+'-01'])).rows;
  res.json({items:rows});
 }));
 app.put('/api/workplace-support',user,admin,wrap(async(req,res)=>{
  const date=String(req.body.date||''),id=Number(req.body.employee_id),workplace=req.body.workplace===null?null:String(req.body.workplace||'');if(!validDate(date)||!Number.isSafeInteger(id)||id<1||(workplace!==null&&!WORK.includes(workplace)))return res.status(400).json({error:'날짜, 직원, 지원 작업장을 확인하세요.'});const month=date.slice(0,7),c=await pool.connect();
  try{await c.query('BEGIN');await lockPeriods(c,[`attendance:${month}`,`holiday:${month}`]);await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['monthly-workplaces-v1',month]);
   const p=(await c.query('SELECT e.id,a.workplace AS base FROM employees e LEFT JOIN monthly_workplace_assignments a ON a.employee_id=e.id AND a.month=$2::date WHERE e.id=$1 AND e.active=true',[id,month+'-01'])).rows[0];if(!p||!p.base){await c.query('ROLLBACK');return res.status(409).json({error:'활성 직원의 해당 월 기본 작업장을 먼저 지정하세요.'})}if(workplace===p.base){await c.query('ROLLBACK');return res.status(400).json({error:'기본 작업장과 다른 지원 작업장을 선택하세요.'})}
   const before=(await c.query('SELECT workplace FROM daily_workplace_support WHERE work_date=$1::date AND employee_id=$2',[date,id])).rows[0]?.workplace||null;
   if(workplace){const assigned=(await c.query('SELECT workplace FROM holiday_plan_assignments WHERE work_date=$1::date AND employee_id=$2',[date,id])).rows[0];if(assigned&&assigned.workplace!==workplace){await c.query('ROLLBACK');return res.status(409).json({error:'이미 배정된 휴일 작업장과 다릅니다. 휴일 배치를 먼저 확인하세요.'})}
    const weekly=(await c.query(`SELECT w.workplace,w.shift,w.week_start::text AS week_start,CASE WHEN o.work_date IS NULL THEN w.employee_id ELSE o.employee_id END AS employee_id FROM weekly_shift_assignments w LEFT JOIN weekly_shift_overrides o ON o.workplace=w.workplace AND o.shift=w.shift AND o.week_start=w.week_start AND o.slot=w.slot AND o.work_date=$1::date WHERE w.week_start <= $1::date AND w.week_start >= ($1::date-interval '6 days')`,[date])).rows;
    if(weekly.some(w=>String(w.employee_id)===String(id)&&w.workplace!==workplace&&date<=shiftRules.add(w.week_start,shiftRules.shiftSpec(w.workplace,w.shift).days-1))){await c.query('ROLLBACK');return res.status(409).json({error:'해당 날짜의 주별 담당 작업장과 다릅니다. 담당자를 먼저 확인하세요.'})}
    await c.query('INSERT INTO daily_workplace_support(work_date,employee_id,workplace) VALUES($1::date,$2,$3) ON CONFLICT(work_date,employee_id) DO UPDATE SET workplace=EXCLUDED.workplace,updated_at=now()',[date,id,workplace]);
   }else await c.query('DELETE FROM daily_workplace_support WHERE work_date=$1::date AND employee_id=$2',[date,id]);
   await c.query('INSERT INTO audit_log(actor_id,action,before_data,after_data) VALUES($1,$2,$3,$4)',[req.user.id,'날짜별 작업장 지원 변경',JSON.stringify({date,employee_id:id,workplace:before}),JSON.stringify({date,employee_id:id,workplace})]);await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }));
};
