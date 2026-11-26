'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.RosterLayout=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const groups=[['하림','싱그린','정다운','중앙축산'],['동우','앤에프']];
 const bands={
  '하림':[{start:5,end:5,time:'07:10~16:10'},{start:6,end:16,time:'08:00~17:00'},{start:17,end:18,time:'15:00~24:00'}],
  '싱그린':[{start:19,end:19,time:'08:00~17:00'},{start:20,end:20,time:'10:00~19:00'}],
  '정다운':[{start:21,end:21,time:'08:00~17:00'}],
  '중앙축산':[{start:23,end:25,time:'07:00~16:00'}],
  '동우':[{start:5,end:8,time:'08:00~17:00'},{start:9,end:9,time:'09:00~18:00'},{start:10,end:11,time:'22:00~07:00'}],
  '앤에프':[{start:12,end:13,time:'08:00~17:00'}]
 };
 function fill(items,first,last){const rows=new Map();for(let r=first;r<=last;r++)rows.set(r,[]);const pending=[];for(const item of items){if(item.row!=null&&item.row>=first&&item.row<=last&&rows.get(item.row).length===0)rows.get(item.row).push(item);else pending.push(item)}for(const item of pending){const row=[...rows.keys()].find(r=>rows.get(r).length===0)??last;rows.get(row).push(item)}return rows}
 function shiftRows(entries,workplace){const rows=new Map();const put=(row,e)=>{if(!rows.has(row))rows.set(row,[]);rows.get(row).push(e)};const group=(items,lo,hi)=>{for(const [r,list] of fill(items,lo,hi))for(const e of list)put(r,e)};
  if(workplace==='하림'){const early=entries.filter(e=>(!e.annotationOnly||e.absenceOnly)&&(e.shift==='조출'||e.shift==='주간'&&Number(e.slot)===1)),night=entries.filter(e=>(!e.annotationOnly||e.absenceOnly)&&e.shift==='야간').map(e=>({...e,row:16+Number(e.slot||1)})),rest=entries.filter(e=>!early.includes(e)&&!(e.shift==='야간'&&(!e.annotationOnly||e.absenceOnly)));group(early,5,5);group(rest,6,16);group(night,17,18)}
  else if(workplace==='싱그린'){const early=entries.filter(e=>(!e.annotationOnly||e.absenceOnly)&&e.shift==='조출'),late=entries.filter(e=>(!e.annotationOnly||e.absenceOnly)&&e.shift==='후출'),other=entries.filter(e=>!early.includes(e)&&!late.includes(e));group([...early,...other],19,19);group(late,20,20)}
  else if(workplace==='정다운')group(entries,21,21);else if(workplace==='중앙축산')group(entries,23,25);
  else if(workplace==='동우'){const late=entries.filter(e=>(!e.annotationOnly||e.absenceOnly)&&e.shift==='후출'),night=entries.filter(e=>(!e.annotationOnly||e.absenceOnly)&&e.shift==='야간').map(e=>({...e,row:9+Number(e.slot||1)})),rest=entries.filter(e=>!late.includes(e)&&!(e.shift==='야간'&&(!e.annotationOnly||e.absenceOnly)));group(rest,5,8);group(late,9,9);group(night,10,11)}
  else if(workplace==='앤에프')group(entries,12,13);return rows;
 }
 function duration(a){if(!a.start_time||!a.end_time)return '';const [h1,m1]=a.start_time.split(':').map(Number),[h2,m2]=a.end_time.split(':').map(Number),minutes=h2*60+m2-h1*60-m1;if(!Number.isFinite(minutes)||minutes<=0)return `${a.start_time}~${a.end_time}`;const h=Math.floor(minutes/60),m=minutes%60;return [h?`${h}h`:'',m?`${m}m`:''].filter(Boolean).join(' ')}
 function attendanceText(e){if(Array.isArray(e.attendanceDetails)&&e.attendanceDetails.length)return e.attendanceDetails.map(a=>[a.type,duration(a)].filter(Boolean).join(' ')).join(', ');return e.attendance||''}
 function compose(e){const parts=[];if(e.annotationOnly&&e.destination)parts.push(e.destination+' 지원');else if(e.support)parts.push('지원');const a=attendanceText(e);if(a)parts.push(a);return e.name+(parts.length?'('+parts.join(', ')+')':'')}
 function hasFourHourAttendance(details){
  const intervals=[];for(const a of details||[]){if(!a.start_time&&!a.end_time)return true;if(!a.start_time||!a.end_time)continue;const [sh,sm]=a.start_time.split(':').map(Number),[eh,em]=a.end_time.split(':').map(Number),start=sh*60+sm,end=eh*60+em;if(Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end<=1440&&start<end)intervals.push([start,end])}
  intervals.sort((a,b)=>a[0]-b[0]);let total=0,start=null,end=null;for(const [a,b] of intervals){if(start===null){start=a;end=b}else if(a<=end)end=Math.max(end,b);else{total+=end-start;start=a;end=b}}if(start!==null)total+=end-start;return total>=240;
 }
 function color(e){return hasFourHourAttendance(e.attendanceDetails)?'leave':e.support||(e.annotationOnly&&!e.absenceOnly)?'support':'normal'}
 return {groups,bands,shiftRows,duration,attendanceText,compose,color,hasFourHourAttendance};
});
