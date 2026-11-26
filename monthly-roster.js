'use strict';
const {add,shiftSpec}=require('./shift-rules');
const WORK=['하림','싱그린','정다운','동우','앤에프','중앙축산'];
const dayName=date=>new Date(date+'T00:00:00Z').getUTCDay();
function effectiveWeekly(date,weekly,overrides){return weekly.flatMap(w=>{const spec=shiftSpec(w.workplace,w.shift);if(!spec||date<w.week_start||date>add(w.week_start,spec.days-1))return [];const o=overrides.find(x=>x.workplace===w.workplace&&x.shift===w.shift&&x.week_start===w.week_start&&Number(x.slot)===Number(w.slot)&&x.work_date===date),id=o?o.employee_id:w.employee_id;return id==null?[]:[{workplace:w.workplace,shift:w.shift,slot:Number(w.slot),employee_id:id,week_start:w.week_start}]})}
function attendanceLabel(items,date,id){return items.filter(x=>String(x.employee_id)===String(id)&&x.start_date<=date&&x.end_date>=date).map(x=>`${x.type}${x.start_time?' '+String(x.start_time).slice(0,5)+'~'+String(x.end_time).slice(0,5):''}`).join(', ')}
function attendanceDetails(items,date,id){return items.filter(x=>String(x.employee_id)===String(id)&&x.start_date<=date&&x.end_date>=date).map(x=>({id:x.id??null,type:x.type,start_date:x.start_date,end_date:x.end_date,start_time:x.start_time?String(x.start_time).slice(0,5):null,end_time:x.end_time?String(x.end_time).slice(0,5):null,note:x.note||''}))}
function buildMonthlyRoster({month,staff,external=[],attendance=[],support=[],weekly=[],overrides=[],holidayDates=[],holidayAssignments=[],friday=[]}){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('월을 확인하세요.');
 const [year,num]=month.split('-').map(Number),last=new Date(Date.UTC(year,num,0)).getUTCDate(),byId=new Map(staff.map(p=>[String(p.id),p])),extId=new Map(external.map(p=>[String(p.id),p])),holidays=new Map(holidayDates.map(x=>[x.date,x])),issues=[],days=[];
 for(const p of staff)if(!p.base||p.base==='미배치')issues.push({type:'미배치',employee_id:p.id,message:`${p.name}: 기본 작업장 미배치`});
 for(let i=1;i<=last;i++){
  const date=month+'-'+String(i).padStart(2,'0'),weekday=dayName(date),holiday=holidays.has(date),weeklyDay=effectiveWeekly(date,weekly,overrides),special=holidayAssignments.filter(a=>a.date===date),places=Object.fromEntries(WORK.map(w=>[w,[]])),byPerson=new Map(),bySlot=new Map();
  const addActual=(person,where,shift,slot,source,extra={})=>{
   if(!WORK.includes(where)){issues.push({type:'작업장 오류',date,message:'유효하지 않은 작업장'});return}
   const key=source+':'+person.id,entry={date,employee_id:source==='staff'?person.id:null,external_id:source==='external'?person.id:null,name:person.name,employee_no:person.employee_no||null,base:person.base||null,workplace:where,shift,slot:slot||null,support:source==='staff'&&!!person.base&&person.base!==where,attendance:source==='staff'?attendanceLabel(attendance,date,person.id):'',attendanceDetails:source==='staff'?attendanceDetails(attendance,date,person.id):[],...extra};
   if(byPerson.has(key)){const old=byPerson.get(key);if(old.workplace===where&&old.shift===shift&&old.slot===entry.slot)return;issues.push({type:'중복 배치',date,employee_id:person.id,message:`${date} ${person.name}: 여러 근무에 배치됨`});return}
   if(slot){const cell=[where,shift,slot].join('|'),old=bySlot.get(cell);if(old&&old!==key){issues.push({type:'중복 근무 칸',date,message:`${date} ${where} ${shift}${slot}: 여러 직원이 배치됨`});return}bySlot.set(cell,key)}
   byPerson.set(key,entry);places[where].push(entry);
  };
  if(holiday){
   for(const a of special){const p=a.external_id?extId.get(String(a.external_id)):byId.get(String(a.employee_id));if(!p){issues.push({type:'직원 확인',date,message:`${date} 비활성 또는 없는 직원의 배치를 확인하세요.`});continue}const w=weeklyDay.find(w=>w.workplace===a.workplace&&w.shift===a.shift&&w.slot===Number(a.slot)&&String(w.employee_id)===String(a.employee_id)),f=w&&friday.find(x=>x.week_start===w.week_start);addActual(p,a.workplace,a.shift,a.slot,a.external_id?'external':'staff',{weekly:!!a.weekly,fridaySpecial:a.workplace==='동우'&&a.shift==='야간'&&weekday===5&&Number(a.slot)===2})}
  }else{
   for(const w of weeklyDay){const p=byId.get(String(w.employee_id));if(!p){issues.push({type:'직원 확인',date,message:`${date} 주별 담당 직원을 확인하세요.`});continue}const f=friday.find(x=>x.week_start===w.week_start);addActual(p,w.workplace,w.shift,w.slot,'staff',{fridaySpecial:w.workplace==='동우'&&w.shift==='야간'&&weekday===5&&Number(w.slot)===2})}
   if(weekday>=1&&weekday<=5)for(const p of staff){if(!WORK.includes(p.base)||byPerson.has('staff:'+p.id))continue;const s=support.find(x=>x.date===date&&String(x.employee_id)===String(p.id));addActual(p,s?.workplace||p.base,s?.shift||'주간',null,'staff')}
  }
  for(const e of byPerson.values())if(e.employee_id){const s=support.find(x=>x.date===date&&String(x.employee_id)===String(e.employee_id));if(s&&s.workplace!==e.workplace)issues.push({type:'지원 충돌',date,employee_id:e.employee_id,message:`${date} ${e.name}: 지원과 근무 작업장이 다름`});if(e.support&&WORK.includes(e.base))places[e.base].push({...e,destination:e.workplace,workplace:e.base,shift:'주간',slot:null,annotationOnly:true})}
  // Keep the original worker's leave visible at their weekly duty when a date substitute is used.
  for(const o of overrides.filter(x=>x.work_date===date&&x.employee_id!==null)){
   const parent=weekly.find(w=>w.workplace===o.workplace&&w.shift===o.shift&&w.week_start===o.week_start&&Number(w.slot)===Number(o.slot));
   if(!parent||String(parent.employee_id)===String(o.employee_id))continue;
   const p=byId.get(String(parent.employee_id)),details=p?attendanceDetails(attendance,date,p.id):[];if(!p||!details.length)continue;
   const existing=byPerson.get('staff:'+p.id);if(existing&&existing.workplace===o.workplace&&!existing.support&&existing.shift==='주간')places[o.workplace]=places[o.workplace].filter(x=>x!==existing);
   places[o.workplace].push({date,employee_id:p.id,external_id:null,name:p.name,employee_no:p.employee_no||null,base:p.base||null,workplace:o.workplace,shift:o.shift,slot:Number(o.slot),support:false,annotationOnly:true,absenceOnly:true,attendance:attendanceLabel(attendance,date,p.id),attendanceDetails:details});
  }
  for(const entries of Object.values(places))entries.sort((a,b)=>{const x=String(a.employee_no||''),y=String(b.employee_no||'');return (!x)-(!y)||x.localeCompare(y,'ko',{numeric:true})});
  const holidayInfo=holidays.get(date),isPublicHoliday=!!holidayInfo&&(weekday!==6||(holidayInfo.auto_saturday===false&&!!holidayInfo.label&&holidayInfo.label!=='토요일'));days.push({date,weekday,holiday,holidayLabel:holidayInfo?.label||'',isPublicHoliday,places});
 }
 return {month,days,issues};
}
module.exports={buildMonthlyRoster,effectiveWeekly,attendanceLabel,attendanceDetails};
