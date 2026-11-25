'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{buildMonthlyRoster}=require('../monthly-roster');
const staff=[{id:1,name:'가상가',base:'하림'},{id:2,name:'가상나',base:'동우'}];
test('support appears in both workplaces but is one actual assignment',()=>{const r=buildMonthlyRoster({month:'2026-12',staff,support:[{date:'2026-12-01',employee_id:1,workplace:'동우'}],attendance:[{employee_id:1,type:'조퇴',start_date:'2026-12-01',end_date:'2026-12-01',start_time:'13:00',end_time:'17:00'}]});const d=r.days[0],own=d.places['하림'].find(x=>x.employee_id===1),dest=d.places['동우'].find(x=>x.employee_id===1);assert.equal(own.annotationOnly,true);assert.equal(dest.support,true);assert.match(dest.attendance,/조퇴 13:00~17:00/);assert.equal(r.issues.length,0)});
test('weekly substitutes and Friday special time follow slot 2',()=>{const weekly=[{workplace:'동우',shift:'야간',week_start:'2026-11-29',slot:2,employee_id:2}],overrides=[{...weekly[0],work_date:'2026-12-04',employee_id:1}];const r=buildMonthlyRoster({month:'2026-12',staff,weekly,overrides,friday:[{week_start:'2026-11-29',slot:1}]});const fri=r.days.find(x=>x.date==='2026-12-04');assert.equal(fri.places['동우'].find(x=>x.shift==='야간').employee_id,1);assert.equal(fri.places['동우'].find(x=>x.shift==='야간').fridaySpecial,true);assert.equal(fri.places['하림'].find(x=>x.employee_id===1).annotationOnly,true)});
test('holiday roster uses actual holiday assignments and detects duplicates',()=>{const r=buildMonthlyRoster({month:'2026-12',staff,external:[{id:5,name:'지원'}],holidayDates:[{date:'2026-12-05'}],holidayAssignments:[{date:'2026-12-05',workplace:'하림',shift:'주간',slot:2,external_id:5},{date:'2026-12-05',workplace:'동우',shift:'주간',slot:1,employee_id:1},{date:'2026-12-05',workplace:'하림',shift:'야간',slot:1,employee_id:1}]});const d=r.days.find(x=>x.date==='2026-12-05');assert(d.places['하림'].some(x=>x.external_id===5));assert(d.places['하림'].some(x=>x.employee_id===1&&x.annotationOnly));assert(r.issues.some(x=>x.type==='중복 배치'))});

test('xlsx preserves both workbook layouts, Friday time, support and a six-week month',async()=>{
 const {makeWorkbook}=require('../monthly-workbook'),ExcelJS=require('exceljs');
 const weekly=[{workplace:'동우',shift:'야간',week_start:'2026-04-26',slot:2,employee_id:2}],support=[{date:'2026-05-04',employee_id:1,workplace:'동우'}];
 const r=buildMonthlyRoster({month:'2026-05',staff,support,weekly,friday:[{week_start:'2026-04-26',slot:1}]});
 const bytes=await makeWorkbook(r),w=new ExcelJS.Workbook();await w.xlsx.load(bytes);assert.equal(w.worksheets.length,2);assert(w.worksheets[0].model.merges.length>20);assert(w.worksheets[1].model.merges.length>400);for(let day=1;day<=31;day++){const idx=Math.floor((5+day-1)/7),weekday=(5+day-1)%7,row=Math.floor(idx/2)*23,col=(idx%2?14:4)+weekday;assert.equal(w.worksheets[0].getCell(4+row,col).value,day)}
 assert.equal(w.worksheets[0].getCell('O6').value,'가상가(동우)');assert.equal(w.worksheets[1].getCell('V5').value,'가상가');
 assert.equal(w.worksheets[0].getCell('N50').value,31);assert.equal(w.worksheets[1].getCell('M11').value,'22:30 ~ 07:30');assert.equal(w.worksheets[1].getCell('N11').value,'가상나');
});
test('workbook dates and weekday headings remain correct across different month layouts',async()=>{
 const {makeWorkbook}=require('../monthly-workbook'),ExcelJS=require('exceljs');for(const month of ['2026-02','2026-05','2026-12','2027-02']){const r=buildMonthlyRoster({month,staff:[]}),w=new ExcelJS.Workbook();await w.xlsx.load(await makeWorkbook(r));const [y,m]=month.split('-').map(Number),first=new Date(Date.UTC(y,m-1,1)).getUTCDay();for(const d of r.days){const n=Number(d.date.slice(8)),idx=Math.floor((first+n-1)/7),side=idx%2,v=Math.floor(idx/2),a=(side?14:4)+d.weekday,b=(side?20:3)+d.weekday*2;assert.equal(w.worksheets[0].getCell(4+v*23,a).value,n);assert.equal(w.worksheets[1].getCell(4+v*11,b).value,n);assert.equal(w.worksheets[0].getCell(3+v*23,a).value,['일','월','화','수','목','금','토'][d.weekday]);assert.equal(w.worksheets[1].getCell(3+v*11,b).value,['일','월','화','수','목','금','토'][d.weekday])}}
});

test('attendance and support are displayed together with leave taking color precedence',()=>{
 const layout=require('../public/roster-layout');
 const r=buildMonthlyRoster({month:'2026-12',staff,support:[{date:'2026-12-01',employee_id:1,workplace:'동우'}],attendance:[{id:12,employee_id:1,type:'조퇴',start_date:'2026-12-01',end_date:'2026-12-01',start_time:'15:00',end_time:'17:00',note:'상세'}, {id:13,employee_id:1,type:'외출',start_date:'2026-12-01',end_date:'2026-12-01',start_time:'12:00',end_time:'13:00'}]});
 const own=r.days[0].places['하림'].find(x=>x.employee_id===1),dest=r.days[0].places['동우'].find(x=>x.employee_id===1);
 assert.equal(layout.compose(own),'가상가(동우, 조퇴 2h, 외출 1h)');assert.equal(layout.compose(dest),'가상가(조퇴 2h, 외출 1h)');assert.equal(layout.color(own),'leave');assert.equal(dest.attendanceDetails[0].note,'상세');
});

test('workbook retains all names and distinguishes mixed support and attendance colors',async()=>{
 const {makeWorkbook}=require('../monthly-workbook'),ExcelJS=require('exceljs');
 const many=Array.from({length:15},(_,i)=>({id:i+1,name:'가상직원'+i,base:'하림'}));
 const r=buildMonthlyRoster({month:'2026-12',staff:many,attendance:[{employee_id:15,type:'병가',start_date:'2026-12-01',end_date:'2026-12-01'}],support:[{date:'2026-12-01',employee_id:14,workplace:'동우'}],holidayDates:[{date:'2026-12-25',label:'성탄절'}]});
 const w=new ExcelJS.Workbook();await w.xlsx.load(await makeWorkbook(r));const a=w.worksheets[0],b=w.worksheets[1];
 const texts=Array.from({length:18},(_,i)=>a.getCell(5+i,6).value).filter(Boolean).map(v=>typeof v==='string'?v:v.richText.map(x=>x.text).join('')).join(' ');
 for(const person of many)assert(texts.includes(person.name),person.name);
 assert(texts.includes('병가'));assert(texts.includes('동우'));assert(a.getCell('F17').value);assert(a.getCell('F18').value);
 assert.equal(a.getCell('J4').font.color.argb,'FF1756B2');assert.equal(a.getCell('N4').font.color.argb,'FFC02636');const christmas=a.getColumn('S').values.findIndex(v=>v===25);assert(christmas>0);assert.equal(a.getCell(christmas,19).font.color.argb,'FFC02636');
 const bnames=Array.from({length:4},(_,i)=>b.getCell(5+i,7).value).filter(Boolean).join(' ');assert(bnames.includes('가상직원13'));
});

test('singgreen support uses the selected time and extra workers have separate worksheet rows',async()=>{
 const {makeWorkbook}=require('../monthly-workbook'),ExcelJS=require('exceljs');
 const people=[{id:1,name:'8시지원',base:'하림'},{id:2,name:'10시지원',base:'동우'},{id:3,name:'싱그린직원',base:'싱그린'},{id:4,name:'앤에프직원1',base:'앤에프'},{id:5,name:'앤에프직원2',base:'앤에프'},{id:6,name:'앤에프지원',base:'동우'}];
 const support=[{date:'2026-12-01',employee_id:1,workplace:'싱그린',shift:'조출'},{date:'2026-12-01',employee_id:2,workplace:'싱그린',shift:'후출'},{date:'2026-12-01',employee_id:6,workplace:'앤에프'}];
 const roster=buildMonthlyRoster({month:'2026-12',staff:people,support});const w=new ExcelJS.Workbook();await w.xlsx.load(await makeWorkbook(roster));const a=w.worksheets[0],b=w.worksheets[1];
 const matches=(s,col,name)=>s.getColumn(col).values.map((v,i)=>({v,i})).filter(x=>x.v===name&&x.i>=5&&x.i<=25).map(x=>x.i);
 const early=matches(a,6,'8시지원'),late=matches(a,6,'10시지원'),base=matches(a,6,'싱그린직원');assert.equal(early.length,1);assert.equal(late.length,1);assert.equal(base.length,1);assert.notEqual(early[0],base[0]);assert(late[0]>Math.max(early[0],base[0]));
 const nf=['앤에프직원1','앤에프직원2','앤에프지원'].map(n=>matches(b,7,n)[0]);assert.equal(new Set(nf).size,3);for(const i of nf)assert(i>=12&&i<=14);
 assert(a.model.merges.length>20);assert(b.model.merges.length>400);assert.equal(a.getCell(4,6).value,1);assert.equal(b.getCell(4,7).value,1);
});
