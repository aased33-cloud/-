'use strict';
let rosterTab=0;
async function monthlyRosterPage(){
 if(user.role!=='admin')return;
 await api('/api/holidays?month='+month);
 const data=await api('/api/monthly-roster/preview?month='+month),layout=RosterLayout;
 const list=(items,limit=20)=>items.slice(0,limit).map(x=>`<li>${esc(x.message||[x.date,x.workplace,x.shift,x.slot?x.slot+'번':'',x.type].filter(Boolean).join(' · '))}</li>`).join('');
 const first=new Date(month+'-01T00:00:00Z').getUTCDay(),weekCount=Math.ceil((first+data.days.length)/7),daysByDate=new Map(data.days.map(d=>[d.date,d]));
 const entryRefs=[];
 function entryButton(e){const index=entryRefs.push(e)-1,kind=layout.color(e),time=e.fridaySpecial?'<span class="roster-special-time">22:30~07:30</span>':'';return `<button type="button" class="roster-person roster-${kind}" data-roster-entry="${index}" aria-label="${esc(layout.compose(e))} 상세 보기">${esc(layout.compose(e))}${time}</button>`}
 function renderWeeks(group){
  entryRefs.length=0;let html='';for(let week=0;week<weekCount;week++){
   const weekDays=Array.from({length:7},(_,dow)=>{const number=week*7+dow-first+1,date=number>=1&&number<=data.days.length?`${month}-${String(number).padStart(2,'0')}`:null;return date?daysByDate.get(date):null});
   const cached=new Map();for(const d of weekDays)if(d)for(const work of group)cached.set(`${d.date}|${work}`,layout.shiftRows(d.places[work]||[],work));
   const headers=weekDays.map((d,dow)=>{const cls=dow===0||d?.isPublicHoliday?'roster-sun':dow===6?'roster-sat':'';return `<th scope="col" class="${cls}">${['일','월','화','수','목','금','토'][dow]}${d?`<span>${Number(d.date.slice(8))}</span>`:''}</th>`}).join('');
   let rows='';for(const work of group){const bands=layout.bands[work],total=bands.reduce((n,b)=>n+b.end-b.start+1,0);let firstWork=true;for(const band of bands){for(let row=band.start;row<=band.end;row++){
    const workCell=firstWork?`<th scope="rowgroup" rowspan="${total}" class="roster-workplace">${esc(work)}</th>`:'';firstWork=false;
    const timeCell=row===band.start?`<th scope="rowgroup" rowspan="${band.end-band.start+1}" class="roster-time">${esc(band.time).replace('~','<br>~')}</th>`:'';
    const cells=weekDays.map(d=>{if(!d)return '<td class="roster-outside"></td>';const entries=cached.get(`${d.date}|${work}`).get(row)||[];return `<td>${entries.map(entryButton).join('')}</td>`}).join('');rows+=`<tr>${workCell}${timeCell}${cells}</tr>`;
   }}}
   html+=`<section class="roster-week" aria-label="${week+1}주차"><table class="roster-week-table"><colgroup><col class="roster-col-work"><col class="roster-col-time">${'<col class="roster-col-day">'.repeat(7)}</colgroup><thead><tr><th scope="col">작업장</th><th scope="col">근무시간</th>${headers}</tr></thead><tbody>${rows}</tbody></table></section>`;
  }return html;
 }
 shell(`<div class="page-title"><div><h1>월 근무표 확인</h1><span class="muted">기본 배치·근태·지원·주별 담당과 휴일근무를 함께 확인합니다.</span></div>${monthControl()}</div><div class="card roster-panel"><div class="roster-toolbar"><div class="row"><button id="roster-check" class="button">다시 확인</button><button id="roster-download" class="button primary" ${data.issues.length?'disabled':''}>엑셀 내려받기</button><span class="muted">문제 ${data.issues.length}건 · 확인 사항 ${data.warnings.length}건</span></div><div id="roster-download-error" class="error" role="alert" aria-live="polite"></div></div>${data.issues.length?`<div class="alert"><strong>내려받기 전 해결할 항목</strong><ul>${list(data.issues)}</ul>${data.issues.length>20?`외 ${data.issues.length-20}건`:''}</div>`:''}${data.warnings.length?`<details class="notice"><summary>필요 인원과 가능 여부 확인 ${data.warnings.length}건</summary><ul>${list(data.warnings,100)}</ul>${data.warnings.length>100?`외 ${data.warnings.length-100}건`:''}</details>`:''}<div class="roster-legend"><span><i class="roster-dot roster-dot-normal"></i>정상</span><span><i class="roster-dot roster-dot-leave"></i>근태</span><span><i class="roster-dot roster-dot-support"></i>지원</span><span class="muted">이름을 누르면 상세 내용을 볼 수 있습니다.</span></div><div class="roster-tabs"><button id="roster-tab-0" class="button ${rosterTab===0?'primary':''}">하림 · 싱그린 · 정다운 · 중앙축산</button><button id="roster-tab-1" class="button ${rosterTab===1?'primary':''}">동우 · 앤에프</button></div><div id="roster-weeks" class="roster-weeks"></div></div>`);
 function draw(){document.querySelector('#roster-weeks').innerHTML=renderWeeks(layout.groups[rosterTab]);for(let i=0;i<2;i++)document.querySelector('#roster-tab-'+i).classList.toggle('primary',rosterTab===i);document.querySelectorAll('[data-roster-entry]').forEach(button=>button.onclick=()=>{
  const e=entryRefs[Number(button.dataset.rosterEntry)],details=e.attendanceDetails||[],support=e.annotationOnly?`${e.base} → ${e.destination}`:e.support?`${e.base} → ${e.workplace}`:'';
  showDialog(`<div class="dialog-inner"><div class="dialog-header"><h2>${esc(e.name)}</h2><button type="button" class="close" id="roster-detail-close" aria-label="닫기">×</button></div><p>${esc(e.date)} · ${esc(e.annotationOnly?e.destination:e.workplace)}</p>${support?`<p>지원: ${esc(support)}</p>`:''}${e.fridaySpecial?'<p>근무시간: 22:30~07:30</p>':''}<h3>근태 상세</h3>${details.length?details.map(a=>`<div class="event-row"><div><strong>${esc(a.type)}</strong><div class="muted">${esc(a.start_date)}${a.end_date!==a.start_date?' ~ '+esc(a.end_date):''}${a.start_time?' · '+esc(a.start_time)+' ~ '+esc(a.end_time):' · 하루'}</div>${a.note?`<div class="detail-note">${esc(a.note)}</div>`:''}</div></div>`).join(''):'<p class="muted">등록된 근태가 없습니다.</p>'}</div>`);document.querySelector('#roster-detail-close').onclick=closeDialog;
 })}
 bindMonth();document.querySelector('#roster-check').onclick=monthlyRosterPage;for(let i=0;i<2;i++)document.querySelector('#roster-tab-'+i).onclick=()=>{rosterTab=i;draw()};draw();
 document.querySelector('#roster-download').onclick=async e=>{
  if(data.warnings.length&&!confirm(`확인 사항 ${data.warnings.length}건이 있습니다. 확인 후 현재 상태로 엑셀을 내려받을까요?`))return;
  const button=e.currentTarget,error=document.querySelector('#roster-download-error');button.disabled=true;error.textContent='';
  try{const response=await fetch('/api/monthly-roster/export?month='+encodeURIComponent(month));if(!response.ok){let message='엑셀을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.';try{const result=await response.json();if(result.error)message=result.error}catch{}throw Error(message)}
   const contentType=response.headers.get('content-type')||'';if(!contentType.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))throw Error('엑셀 파일을 확인하지 못했습니다. 다시 시도해 주세요.');
   const bytes=await response.arrayBuffer(),signature=new Uint8Array(bytes,0,Math.min(bytes.byteLength,2));if(bytes.byteLength<1024||signature[0]!==0x50||signature[1]!==0x4b)throw Error('엑셀 파일이 비어 있거나 올바르지 않습니다. 다시 시도해 주세요.');
   const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})),a=document.createElement('a');a.href=url;a.download='근무편성표-'+month+'.xlsx';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(err){error.textContent=err.message||'엑셀을 만들지 못했습니다.'}finally{button.disabled=false}
 };
}
