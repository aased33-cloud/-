'use strict';
const {buildMonthlyRoster,effectiveWeekly}=require('./monthly-roster'),{makeWorkbook}=require('./monthly-workbook'),plan=require('./holiday-plan-routes'),{eligibleStaff}=require('./holiday-planner');
const shiftRules=require('./shift-rules');
const WORK=['하림','싱그린','정다운','동우','앤에프','중앙축산'],SHIFTS=['조출','주간','후출','야간'];
const key=(d,w,s,n)=>[d,w,s,n].join('|');
async function readRoster(pool,month){
 const client=await pool.connect();let state,friday;try{await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');state=await plan.readState(client,month);friday=(await client.query(`SELECT week_start::text AS week_start,slot FROM dongwoo_friday_time WHERE week_start >= ($1::date-interval '7 days') AND week_start < ($1::date+interval '1 month')`,[month+'-01'])).rows;await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 const shown=[...state.assignments,...state.weeklyAssignments.filter(a=>a.employee_id!==null)];
 const roster=buildMonthlyRoster({month,staff:state.staff,external:state.external,attendance:state.attendance,support:state.support,weekly:state.weekly,overrides:state.overrides,holidayDates:state.dates,holidayAssignments:shown,friday});
 for(const x of state.support){
  if(x.workplace!=='싱그린'||x.shift)continue;
  const day=roster.days.find(d=>d.date===x.date),assigned=day?.places['싱그린'].find(e=>String(e.employee_id)===String(x.employee_id)&&!e.annotationOnly);
  if(assigned&&!assigned.weekly&&assigned.shift==='주간')roster.issues.push({type:'지원 근무시간 미지정',date:x.date,employee_id:x.employee_id,message:`${x.date} 싱그린 지원자의 출근시간을 지정하세요.`});
 }
 const input=plan.asPlanner(state),warnings=[];
 for(const d of state.dates)for(const w of WORK)for(const shift of SHIFTS)for(let slot=1;slot<=plan.needFor(state,d.date,w,shift);slot++)if(!shown.some(a=>a.date===d.date&&a.workplace===w&&a.shift===shift&&Number(a.slot)===slot))warnings.push({type:'휴일 필요 인원 부족',date:d.date,workplace:w,shift,slot});
 for(const a of shown){const slot=input.slots.find(s=>s.id===key(a.date,a.workplace,a.shift,a.slot));const person=a.external_id?input.external.find(p=>String(p.id)===String(a.external_id)):input.staff.find(p=>String(p.id)===String(a.employee_id));if(!slot||!person||(a.external_id?person.availability?.[a.date]!==true:!eligibleStaff(person,slot)))warnings.push({type:'가능 여부 확인',date:a.date,workplace:a.workplace,shift:a.shift,slot:a.slot});}
 for(const day of roster.days){
  if(day.holiday)continue;
  const expected=[];
  if(day.weekday>=1&&day.weekday<=5){if(state.staff.some(p=>p.base==='하림'))expected.push(['하림','조출',1],['하림','야간',1],['하림','야간',2]);if(state.staff.some(p=>p.base==='동우'))expected.push(['동우','후출',1],['동우','야간',1],['동우','야간',2]);if(state.staff.some(p=>p.base==='싱그린'))expected.push(['싱그린','조출',1],['싱그린','후출',1]);}
  if(day.weekday===0&&state.staff.some(p=>p.base==='동우'))expected.push(['동우','야간',1],['동우','야간',2]);
  const actual=effectiveWeekly(day.date,state.weekly,state.overrides);
  for(const a of actual){
   const person=state.staff.find(p=>String(p.id)===String(a.employee_id)),items=state.attendance.filter(x=>String(x.employee_id)===String(a.employee_id));
   if(a.shift==='야간'){
    const spec=shiftRules.shiftSpec(a.workplace,a.shift),end=shiftRules.add(a.week_start,spec.days-1);
    if(!person||!shiftRules.inNightPool(person.base,a.workplace)||state.exclusions.some(x=>String(x.employee_id)===String(a.employee_id))||state.unavailableWeeks.some(x=>String(x.employee_id)===String(a.employee_id)&&x.workplace===a.workplace&&x.week_start===a.week_start)||shiftRules.hasAttendance(items,a.week_start,end,true))warnings.push({type:'야간 담당 근태·불가 주간 확인',date:day.date,workplace:a.workplace,shift:a.shift,slot:a.slot});
   }else if(items.some(x=>x.start_date<=day.date&&x.end_date>=day.date))warnings.push({type:'주별 담당자의 근태 확인',date:day.date,workplace:a.workplace,shift:a.shift,slot:a.slot});
  }
  for(const [workplace,shift,slot] of expected)if(!actual.some(a=>a.workplace===workplace&&a.shift===shift&&Number(a.slot)===slot))warnings.push({type:'주별 담당 미배치',date:day.date,workplace,shift,slot});
  if(day.weekday===5){const night=actual.filter(a=>a.workplace==='동우'&&a.shift==='야간');if(night.length&&!night.some(a=>friday.some(f=>f.week_start===a.week_start&&Number(f.slot)===Number(a.slot))))warnings.push({type:'금요일 특별시간 미지정',date:day.date,workplace:'동우',shift:'야간'});}
 }
 return {...roster,warnings};
}
module.exports=function(app,pool,user,admin,wrap){
 const getMonth=(req,res)=>{const month=String(req.query.month||'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)){res.status(400).json({error:'월을 확인하세요.'});return null}return month};
 app.get('/api/monthly-roster/check',user,admin,wrap(async(req,res)=>{const month=getMonth(req,res);if(!month)return;const r=await readRoster(pool,month);res.json({month,issues:r.issues,warnings:r.warnings})}));
 app.get('/api/monthly-roster/preview',user,admin,wrap(async(req,res)=>{const month=getMonth(req,res);if(!month)return;res.json(await readRoster(pool,month))}));
 app.get('/api/monthly-roster/export',user,admin,wrap(async(req,res)=>{const month=getMonth(req,res);if(!month)return;const r=await readRoster(pool,month);const blocking=r.issues.filter(issue=>issue.type!=='미배치');if(blocking.length)return res.status(409).json({error:'근무표의 배치 충돌이나 시간 미지정을 먼저 확인하세요.',issues:blocking});const bytes=await makeWorkbook(r);if(!Buffer.isBuffer(bytes)||bytes.length<1024||bytes[0]!==0x50||bytes[1]!==0x4b)throw Error('생성된 엑셀 파일을 확인할 수 없습니다.');res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.set('Content-Disposition',`attachment; filename="roster-${month}.xlsx"`);res.send(bytes)}));
};
module.exports.readRoster=readRoster;
