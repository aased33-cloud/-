'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{PGlite}=require('@electric-sql/pglite'),express=require('express'),request=require('supertest'),fs=require('node:fs'),path=require('node:path');
async function setup(){
 const db=new PGlite();await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;
 CREATE TABLE employees(id bigint PRIMARY KEY,name text,employee_no text,active boolean);
 CREATE TABLE attendance(id bigserial PRIMARY KEY,employee_id bigint,type text,start_date date,end_date date,start_time time,end_time time,note text);
 CREATE TABLE audit_log(id bigserial,actor_id bigint,action text,record_id bigint,before_data jsonb,after_data jsonb,created_at timestamptz DEFAULT now());
 INSERT INTO employees VALUES(1,'관리자','A001',true),(2,'직원','A002',true),(3,'야간불가','A003',true);`);
 const migration=fs.readFileSync(path.join(__dirname,'../migration.sql'),'utf8');await db.exec(migration);await db.exec(migration);
 await db.exec(`INSERT INTO monthly_workplace_assignments(month,employee_id,workplace) VALUES('2026-12-01',1,'하림'),('2026-12-01',2,'하림'),('2026-12-01',3,'하림');
 INSERT INTO holiday_dates(holiday_date,label) VALUES('2026-12-05','토'),('2026-12-12','토');
 INSERT INTO holiday_preferences(holiday_id,employee_id,status,night_status) SELECT id,1,'available','allowed' FROM holiday_dates;
 INSERT INTO holiday_preferences(holiday_id,employee_id,status,night_status) SELECT id,2,'unavailable','allowed' FROM holiday_dates;
 INSERT INTO holiday_preferences(holiday_id,employee_id,status,night_status) SELECT id,3,'available','unavailable' FROM holiday_dates;`);
 const client={query:(...args)=>db.query(...args).then(r=>({...r,rowCount:String(args[0]).trim().startsWith('SELECT')?r.rows.length:(r.affectedRows??r.rows.length)})),release:()=>{}},pool={query:client.query,connect:async()=>client},app=express();app.use(express.json());
 const user=(req,res,next)=>{const role=req.get('x-role')||'admin';req.user={id:role==='employee'?2:1,role};next()},admin=(req,res,next)=>req.user.role==='admin'?next():res.sendStatus(403),wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>{console.error(e);res.sendStatus(500)});require('../extra-routes')(app,pool,user,admin,wrap);require('../holiday-plan-routes')(app,pool,user,admin,wrap);require('../shift-routes')(app,pool,user,admin,wrap);require('../support-routes')(app,pool,user,admin,wrap);require('../roster-routes')(app,pool,user,admin,wrap);return {db,app};
}
const assignment={month:'2026-12',date:'2026-12-05',workplace:'하림',shift:'주간',slot:2};
test('manual placement checks availability, privileges, duplicates and night eligibility',async()=>{const {db,app}=await setup();try{
 await request(app).get('/api/holiday-plan?month=2026-12').set('x-role','employee').expect(403);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,employee_id:2}).expect(409);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,employee_id:2,confirm_unavailable:true}).expect(200);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,slot:3,employee_id:2,confirm_unavailable:true}).expect(409);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,slot:1,shift:'야간',employee_id:3}).expect(409);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,slot:1,shift:'야간',employee_id:1}).expect(200);
 let r=await request(app).get('/api/holiday-plan?month=2026-12').expect(200);assert.equal(r.body.assignments.length,2);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,employee_id:null}).expect(200);
 r=await request(app).get('/api/holiday-plan?month=2026-12').expect(200);assert.equal(r.body.assignments.length,1);
 }finally{await db.close()}});
test('external support cannot be early or exceed two people per date',async()=>{const {db,app}=await setup();try{
 const ids=[];for(const name of ['지원1','지원2','지원3']){const x=await request(app).post('/api/holiday-plan/external').send({month:'2026-12',name}).expect(200);ids.push(Number(x.body.id));await request(app).put('/api/holiday-plan/external-availability').send({month:'2026-12',date:'2026-12-05',external_id:ids.at(-1),available:true}).expect(200)}
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,slot:1,external_id:ids[0]}).expect(400);
 for(let i=0;i<2;i++)await request(app).put('/api/holiday-plan/assignment').send({...assignment,slot:i+2,external_id:ids[i]}).expect(200);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,slot:4,external_id:ids[2]}).expect(409);
 await request(app).put('/api/holiday-plan/requirements').send({month:'2026-12',date:'2026-12-05',workplace:'하림',shift:'주간',required:1}).expect(409);
 }finally{await db.close()}});
test('automatic assignment respects manual placements and rejects incompatible night staff',async()=>{const {db,app}=await setup();try{
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,employee_id:3}).expect(200);
 await request(app).post('/api/holiday-plan/auto').send({month:'2026-12'}).expect(200);
 const r=await request(app).get('/api/holiday-plan?month=2026-12').expect(200);
 const kept=r.body.assignments.find(x=>x.date===assignment.date&&x.workplace==='하림'&&x.shift==='주간'&&x.slot===2);assert.equal(Number(kept.employee_id),3);assert.equal(kept.locked,true);
 assert(!r.body.assignments.some(x=>Number(x.employee_id)===3&&x.shift==='야간'));
 assert.equal(new Set(r.body.assignments.filter(x=>x.date==='2026-12-05'&&x.employee_id).map(x=>String(x.employee_id))).size,r.body.assignments.filter(x=>x.date==='2026-12-05'&&x.employee_id).length);
 }finally{await db.close()}});
test('weekly assignments are visible and holiday changes update the date substitute',async()=>{const {db,app}=await setup();try{
 await db.exec("INSERT INTO weekly_shift_assignments(workplace,shift,week_start,slot,employee_id) VALUES('하림','야간','2026-11-30',1,1)");
 let r=await request(app).get('/api/holiday-plan?month=2026-12').expect(200);const shown=r.body.assignments.find(a=>a.date==='2026-12-05'&&a.workplace==='하림'&&a.shift==='야간'&&a.slot===1);assert.equal(Number(shown.employee_id),1);assert.equal(shown.weekly,true);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,shift:'야간',slot:1,employee_id:2}).expect(200);
 const row=(await db.query("SELECT employee_id FROM weekly_shift_overrides WHERE work_date='2026-12-05'")).rows[0];assert.equal(Number(row.employee_id),2);
 r=await request(app).get('/api/holiday-plan?month=2026-12').expect(200);assert.equal(Number(r.body.assignments.find(a=>a.date==='2026-12-05'&&a.workplace==='하림'&&a.shift==='야간'&&a.slot===1).employee_id),2);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,slot:3,employee_id:2,confirm_unavailable:true}).expect(409);
 }finally{await db.close()}});
test('weekly changes cannot silently overlap holiday assignments',async()=>{const {db,app}=await setup();try{
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,employee_id:1}).expect(200);
 const q={month:'2026-12',workplace:'하림',shift:'야간',week_start:'2026-11-30',slot:1,employee_id:1};
 const r=await request(app).put('/api/weekly-shift').send(q).expect(409);assert.match(r.body.error,/휴일근무/);
 await db.exec("INSERT INTO weekly_shift_assignments(workplace,shift,week_start,slot,employee_id) VALUES('하림','야간','2026-11-30',1,2)");
 await request(app).put('/api/holiday-plan/requirements').send({month:'2026-12',date:'2026-12-05',workplace:'하림',shift:'야간',required:0}).expect(409);
 }finally{await db.close()}});
test('changing an assigned external worker to unavailable warns and preserves the assignment',async()=>{const {db,app}=await setup();try{
 const add=await request(app).post('/api/holiday-plan/external').send({month:'2026-12',name:'지원자'}).expect(200),id=Number(add.body.id),pref={month:'2026-12',date:'2026-12-05',external_id:id,available:true};
 await request(app).put('/api/holiday-plan/external-availability').send(pref).expect(200);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,external_id:id}).expect(200);
 await request(app).put('/api/holiday-plan/external-availability').send({...pref,available:false}).expect(409);
 await request(app).put('/api/holiday-plan/external-availability').send({...pref,available:false,confirm_conflict:true}).expect(200);
 let state=await request(app).get('/api/holiday-plan?month=2026-12').expect(200);assert(state.body.conflicts.some(c=>Number(c.external_id)===id));assert(state.body.assignments.some(a=>Number(a.external_id)===id));
 await request(app).patch('/api/holiday-plan/external/'+id).send({month:'2026-12',name:'지원자',active:false}).expect(409);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,external_id:null}).expect(200);
 await request(app).patch('/api/holiday-plan/external/'+id).send({month:'2026-12',name:'지원자',active:false}).expect(200);
 state=await request(app).get('/api/holiday-plan?month=2026-12').expect(200);assert(state.body.inactiveExternal.some(p=>Number(p.id)===id));
 await request(app).patch('/api/holiday-plan/external/'+id).send({month:'2026-12',name:'지원자',active:true}).expect(200);
 }finally{await db.close()}});
test('daily support preserves the base workplace and prevents conflicting holiday work',async()=>{const {db,app}=await setup();try{
 const support={date:'2026-12-05',employee_id:1,workplace:'싱그린'};
 await request(app).get('/api/workplace-support?month=2026-12').set('x-role','employee').expect(403);
 await request(app).put('/api/workplace-support').send(support).expect(200);
 const r=await request(app).get('/api/workplace-support?month=2026-12').expect(200);assert.equal(r.body.items[0].base,'하림');assert.equal(r.body.items[0].workplace,'싱그린');
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,employee_id:1}).expect(409);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,workplace:'싱그린',shift:'조출',slot:1,employee_id:1}).expect(200);
 await request(app).put('/api/workplace-support').send({...support,workplace:'동우'}).expect(409);
 await request(app).put('/api/workplace-support').send({...support,workplace:null}).expect(200);
 assert.equal((await db.query("SELECT workplace FROM monthly_workplace_assignments WHERE month='2026-12-01' AND employee_id=1")).rows[0].workplace,'하림');
 }finally{await db.close()}});
test('admin can check and download the filled workbook without production data',async()=>{const {db,app}=await setup();try{
 await request(app).put('/api/workplace-support').send({date:'2026-12-01',employee_id:1,workplace:'동우'}).expect(200);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,employee_id:1}).expect(200);
 await request(app).get('/api/monthly-roster/check?month=2026-12').set('x-role','employee').expect(403);
 const check=await request(app).get('/api/monthly-roster/check?month=2026-12').expect(200);assert.equal(check.body.issues.length,0);assert(check.body.warnings.some(w=>w.type==='휴일 필요 인원 부족'));
 const resp=await request(app).get('/api/monthly-roster/export?month=2026-12').buffer(true).parse((res,cb)=>{const parts=[];res.on('data',x=>parts.push(x));res.on('end',()=>cb(null,Buffer.concat(parts)))}).expect(200);
 const ExcelJS=require('exceljs'),book=new ExcelJS.Workbook();await book.xlsx.load(resp.body);assert.equal(book.worksheets.length,2);assert(Array.from({length:11},(_,i)=>book.worksheets[0].getCell('F'+(i+6)).value).includes('관리자(동우 지원)'));assert.equal(book.worksheets[1].getCell('G5').value,'관리자(지원)');assert.equal(book.worksheets[0].getCell('J6').value,'관리자');
 }finally{await db.close()}});
test('roster check warns when attendance is added after weekly night assignment',async()=>{const {db,app}=await setup();try{
 const weekly={month:'2026-12',workplace:'하림',shift:'야간',week_start:'2026-11-30',slot:1,employee_id:1};await request(app).put('/api/weekly-shift').send(weekly).expect(200);
 await db.exec("INSERT INTO attendance(employee_id,type,start_date,end_date,note) VALUES(1,'병가','2026-12-01','2026-12-01','')");
 const r=await request(app).get('/api/monthly-roster/check?month=2026-12').expect(200);assert(r.body.warnings.some(w=>w.date==='2026-12-01'&&w.type==='야간 담당 근태·불가 주간 확인'));
 }finally{await db.close()}});
test('added holiday shares employee registration and remains unregistered after the deadline',async()=>{const {db,app}=await setup();try{
 const month='2020-01',date='2020-01-14';await db.exec("INSERT INTO monthly_deadlines(kind,month,start_date,deadline_date) VALUES('holiday','2020-01-01','2019-12-01','2019-12-02')");
 await request(app).post('/api/holidays').set('x-role','employee').send({holiday_date:date,label:'추가 휴일'}).expect(403);
 await request(app).post('/api/holidays').send({holiday_date:date,label:'추가 휴일'}).expect(200);
 const holidays=await request(app).get('/api/holidays').set('x-role','employee').query({month}).expect(200),day=holidays.body.find(x=>x.holiday_date===date);assert(day);
 const prefs=await request(app).get('/api/holiday-preferences').set('x-role','employee').query({month}).expect(200);assert(!prefs.body.some(x=>Number(x.holiday_id)===Number(day.id)));
 await request(app).put('/api/holiday-preferences/'+day.id).set('x-role','employee').send({status:'available',night_status:'allowed'}).expect(403);
 const plan=await request(app).get('/api/holiday-plan').query({month}).expect(200);assert(plan.body.dates.some(x=>x.date===date));assert(!plan.body.preferences.some(x=>x.date===date));
 const auto=await request(app).post('/api/holiday-plan/auto').send({month}).expect(409);assert(auto.body.warning.includes('미등록'));assert(auto.body.missing.some(x=>x.date===date));
 for(const workplace of ['정다운','중앙축산','앤에프']){await request(app).put('/api/holiday-plan/requirements').send({month,date,workplace,shift:'주간',required:2}).expect(200)}
 const updated=await request(app).get('/api/holiday-plan').query({month}).expect(200);for(const workplace of ['정다운','중앙축산','앤에프'])assert.equal(updated.body.defaults[[date,workplace,'주간',''].join('|')],2);
 await request(app).put('/api/holiday-preferences/'+day.id).send({employee_id:2,status:'available',night_status:'allowed'}).expect(200);
 const recorded=await request(app).get('/api/holiday-preferences').set('x-role','employee').query({month}).expect(200);assert(recorded.body.some(x=>x.holiday_date===date&&x.status==='available'));
 }finally{await db.close()}});
test('re-adding an excluded holiday preserves earlier employee preferences',async()=>{const {db,app}=await setup();try{
 const row=(await db.query("INSERT INTO holiday_dates(holiday_date,label,excluded) VALUES('2020-01-15','기존',true) RETURNING id")).rows[0];
 await db.query("INSERT INTO holiday_preferences(holiday_id,employee_id,status,night_status,note) VALUES($1,2,'unavailable','allowed','보존')",[row.id]);
 await request(app).post('/api/holidays').send({holiday_date:'2020-01-15',label:'다시 사용'}).expect(200);
 const p=(await db.query('SELECT status,night_status,note FROM holiday_preferences WHERE holiday_id=$1 AND employee_id=2',[row.id])).rows[0];assert.deepEqual(p,{status:'unavailable',night_status:'allowed',note:'보존'});
 await request(app).post('/api/holidays').send({holiday_date:'2020-01-15',label:'다른 이름'}).expect(409);
 const h=(await db.query('SELECT label,excluded FROM holiday_dates WHERE id=$1',[row.id])).rows[0];assert.deepEqual(h,{label:'다시 사용',excluded:false});
 }finally{await db.close()}});

test('empty or unassigned roster downloads the formatted two-sheet workbook',async()=>{const {db,app}=await setup();try{
 const ExcelJS=require('exceljs'),read=()=>request(app).get('/api/monthly-roster/export?month=2026-12').buffer(true).parse((r,cb)=>{const chunks=[];r.on('data',x=>chunks.push(x));r.on('end',()=>cb(null,Buffer.concat(chunks)))}).expect(200);
 await db.exec('UPDATE employees SET active=false');let r=await read(),w=new ExcelJS.Workbook();await w.xlsx.load(r.body);assert.equal(w.worksheets.length,2);assert.equal(w.worksheets[0].getCell('F4').value,1);assert.equal(w.worksheets[1].getCell('G4').value,1);assert.match(String(w.worksheets[0].getCell('C5').value),/07:10/);
 await db.exec("UPDATE employees SET active=true;DELETE FROM monthly_workplace_assignments WHERE month='2026-12-01'");const check=await request(app).get('/api/monthly-roster/preview?month=2026-12').expect(200);assert.equal(check.body.issues.filter(x=>x.type==='미배치').length,3);r=await read();w=new ExcelJS.Workbook();await w.xlsx.load(r.body);assert.equal(w.worksheets.length,2);
 }finally{await db.close()}});

test('singgreen support stores the selected shift without altering the base workplace',async()=>{const {db,app}=await setup();try{
 for(const shift of ['조출','후출']){await request(app).put('/api/workplace-support').send({date:'2026-12-01',employee_id:1,workplace:'싱그린',shift}).expect(200);const r=await request(app).get('/api/workplace-support?month=2026-12').expect(200);assert.equal(r.body.items[0].shift,shift);const roster=await request(app).get('/api/monthly-roster/preview?month=2026-12').expect(200);assert.equal(roster.body.days[0].places['싱그린'].find(x=>Number(x.employee_id)===1).shift,shift)}
 await request(app).put('/api/workplace-support').send({date:'2026-12-01',employee_id:1,workplace:'싱그린',shift:'bad'}).expect(400);
 assert.equal((await db.query("SELECT workplace FROM monthly_workplace_assignments WHERE employee_id=1 AND month='2026-12-01'")).rows[0].workplace,'하림');
 }finally{await db.close()}});

test('moving a holiday assignment is atomic and retains the original on invalid target',async()=>{const {db,app}=await setup();try{
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,employee_id:1}).expect(200);
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,shift:'야간',slot:1,employee_id:3}).expect(409);
 let r=await request(app).put('/api/holiday-plan/assignment').send({...assignment,workplace:'동우',shift:'야간',slot:1,employee_id:1,move_existing:true}).expect(409);
 let state=await request(app).get('/api/holiday-plan?month=2026-12').expect(200);assert(state.body.assignments.some(a=>Number(a.employee_id)===1&&a.workplace==='하림'));
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,workplace:'싱그린',shift:'조출',slot:1,employee_id:1,move_existing:true}).expect(200);
 state=await request(app).get('/api/holiday-plan?month=2026-12').expect(200);const rows=state.body.assignments.filter(a=>Number(a.employee_id)===1&&a.date==='2026-12-05');assert.equal(rows.length,1);assert.equal(rows[0].workplace,'싱그린');
 }finally{await db.close()}});

test('month weekly grid is administrator-only and contains cross-month weeks',async()=>{const {db,app}=await setup();try{
 await request(app).get('/api/weekly-shift/month?month=2026-12').set('x-role','employee').expect(403);const r=await request(app).get('/api/weekly-shift/month?month=2026-12').expect(200);const dong=r.body.options.find(o=>o.workplace==='동우'&&o.shift==='야간');assert(dong.weeks.some(w=>w.start==='2026-11-29'&&w.end==='2026-12-04'));assert(dong.weeks.some(w=>w.start==='2026-12-27'&&w.end==='2027-01-01'));
 }finally{await db.close()}});

test('automatic rerun varies the plan without moving locked placements or double-booking',async()=>{const {db,app}=await setup();try{
 await db.exec("UPDATE holiday_preferences SET status='available',night_status='allowed'");
 await request(app).put('/api/holiday-plan/assignment').send({...assignment,employee_id:1}).expect(200);
 let a=await request(app).post('/api/holiday-plan/auto').send({month:'2026-12'}).expect(200);
 let first=(await request(app).get('/api/holiday-plan?month=2026-12').expect(200)).body.assignments;
 let b=await request(app).post('/api/holiday-plan/auto').send({month:'2026-12'}).expect(200);
 let second=(await request(app).get('/api/holiday-plan?month=2026-12').expect(200)).body.assignments;
 const sig=rows=>rows.filter(x=>!x.locked).map(x=>[x.date,x.workplace,x.shift,x.slot,x.employee_id,x.external_id].join('|')).sort().join(';');
 assert.notEqual(sig(first),sig(second));assert.equal(b.body.same_result,false);
 for(const rows of [first,second]){assert(rows.some(x=>x.date==='2026-12-05'&&x.workplace==='하림'&&x.shift==='주간'&&Number(x.slot)===2&&Number(x.employee_id)===1&&x.locked));const occupied=rows.filter(x=>x.employee_id).map(x=>x.date+':'+x.employee_id);assert.equal(new Set(occupied).size,occupied.length)}
 }finally{await db.close()}});

test('removing holiday support clears both related records in one transaction',async()=>{const {db,app}=await setup();try{
 await request(app).put('/api/workplace-support').send({date:'2026-12-05',employee_id:1,workplace:'싱그린',shift:'조출'}).expect(200);
 const entry={month:'2026-12',date:'2026-12-05',workplace:'싱그린',shift:'조출',slot:1};await request(app).put('/api/holiday-plan/assignment').send({...entry,employee_id:1}).expect(200);
 await request(app).put('/api/holiday-plan/assignment').send({...entry,employee_id:null,external_id:null,clear_support:true}).expect(200);
 assert.equal(Number((await db.query("SELECT count(*) AS n FROM daily_workplace_support WHERE employee_id=1 AND work_date='2026-12-05'")).rows[0].n),0);
 assert.equal(Number((await db.query("SELECT count(*) AS n FROM holiday_plan_assignments WHERE employee_id=1 AND work_date='2026-12-05'")).rows[0].n),0);
 }finally{await db.close()}});

test('weekday workplace swap is atomic and preserves original assignments',async()=>{const {db,app}=await setup();try{
 await db.exec("UPDATE monthly_workplace_assignments SET workplace='동우' WHERE month='2026-12-01' AND employee_id=2");
 const body={date:'2026-12-07',employee_id:1,other_employee_id:2,shifts:{}};
 await request(app).post('/api/workplace-support/swap').set('x-role','employee').send(body).expect(403);
 await request(app).post('/api/workplace-support/swap').send(body).expect(200);
 const r=await request(app).get('/api/monthly-roster/preview?month=2026-12').expect(200),d=r.body.days.find(x=>x.date===body.date);
 assert(d.places['동우'].some(x=>Number(x.employee_id)===1&&x.support&&!x.annotationOnly));assert(d.places['하림'].some(x=>Number(x.employee_id)===2&&x.support&&!x.annotationOnly));
 assert(d.places['하림'].some(x=>Number(x.employee_id)===1&&x.annotationOnly));assert(d.places['동우'].some(x=>Number(x.employee_id)===2&&x.annotationOnly));
 const base=await db.query("SELECT workplace FROM monthly_workplace_assignments WHERE month='2026-12-01' ORDER BY employee_id");assert.deepEqual(base.rows.map(x=>x.workplace),['하림','동우','하림']);
 await request(app).post('/api/workplace-support/swap').send(body).expect(200);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM daily_workplace_support WHERE work_date='2026-12-07'")).rows[0].n,0);
 await request(app).post('/api/workplace-support/swap').send({...body,date:'2026-12-05'}).expect(409);
 }finally{await db.close()}});

test('changing a weekday support worker preserves the old worker if validation fails',async()=>{const {db,app}=await setup();try{
 await db.exec("UPDATE monthly_workplace_assignments SET workplace='동우' WHERE employee_id IN (2,3) AND month='2026-12-01'");
 const original={date:'2026-12-07',employee_id:2,workplace:'하림',shift:null};await request(app).put('/api/workplace-support').send(original).expect(200);
 await db.exec("INSERT INTO attendance(employee_id,type,start_date,end_date,note) VALUES(3,'연차','2026-12-07','2026-12-07','')");
 await request(app).put('/api/workplace-support').send({...original,employee_id:3,replace_employee_id:2}).expect(409);
 let rows=(await db.query("SELECT employee_id FROM daily_workplace_support WHERE work_date='2026-12-07'")).rows;assert.deepEqual(rows.map(x=>Number(x.employee_id)),[2]);
 await db.exec('DELETE FROM attendance WHERE employee_id=3');await request(app).put('/api/workplace-support').send({...original,employee_id:3,replace_employee_id:2}).expect(200);
 rows=(await db.query("SELECT employee_id FROM daily_workplace_support WHERE work_date='2026-12-07'")).rows;assert.deepEqual(rows.map(x=>Number(x.employee_id)),[3]);
 }finally{await db.close()}});

test('holiday swap validates both workers and changes both assignments atomically',async()=>{const {db,app}=await setup();try{
 await db.exec("UPDATE monthly_workplace_assignments SET workplace='동우' WHERE month='2026-12-01' AND employee_id=2; UPDATE holiday_preferences SET status='available' WHERE employee_id=2");
 const date='2026-12-05',body={date,employee_id:1,other_employee_id:2};
 await request(app).put('/api/holiday-plan/assignment').send({month:'2026-12',date,workplace:'하림',shift:'주간',slot:2,employee_id:1}).expect(200);
 await request(app).put('/api/holiday-plan/assignment').send({month:'2026-12',date,workplace:'동우',shift:'주간',slot:1,employee_id:2}).expect(200);
 await db.exec("UPDATE holiday_preferences SET night_status='unavailable',status='unavailable' WHERE employee_id=2");
 let r=await request(app).post('/api/workplace-support/swap').send(body).expect(409);assert(r.body.warning);
 const before=(await db.query("SELECT workplace,employee_id FROM holiday_plan_assignments WHERE work_date='2026-12-05' ORDER BY workplace")).rows;assert.deepEqual(before.map(x=>Number(x.employee_id)),[2,1]);
 await request(app).post('/api/workplace-support/swap').send({...body,confirm_unavailable:true}).expect(200);
 const after=(await db.query("SELECT workplace,employee_id FROM holiday_plan_assignments WHERE work_date='2026-12-05' ORDER BY workplace")).rows;assert.deepEqual(after.map(x=>Number(x.employee_id)),[1,2]);
 const preview=await request(app).get('/api/monthly-roster/preview?month=2026-12').expect(200),d=preview.body.days.find(x=>x.date===date);assert(d.places['하림'].some(x=>Number(x.employee_id)===2&&x.support&&!x.annotationOnly));assert(d.places['동우'].some(x=>Number(x.employee_id)===1&&x.support&&!x.annotationOnly));
 }finally{await db.close()}});

test('weekday swap uses a date override for a weekly duty and preserves the weekly assignment',async()=>{const {db,app}=await setup();try{
 await db.exec("UPDATE monthly_workplace_assignments SET workplace='동우' WHERE month='2026-12-01' AND employee_id=2");
 await request(app).put('/api/weekly-shift').send({month:'2026-12',workplace:'하림',shift:'조출',week_start:'2026-12-07',slot:1,employee_id:1}).expect(200);
 const body={date:'2026-12-07',employee_id:1,other_employee_id:2};await request(app).post('/api/workplace-support/swap').send(body).expect(200);
 const w=(await db.query("SELECT employee_id FROM weekly_shift_assignments WHERE workplace='하림' AND shift='조출' AND week_start='2026-12-07'")).rows;assert.equal(Number(w[0].employee_id),1);
 const o=(await db.query("SELECT employee_id FROM weekly_shift_overrides WHERE workplace='하림' AND shift='조출' AND work_date='2026-12-07'")).rows;assert.equal(Number(o[0].employee_id),2);
 const r=await request(app).get('/api/monthly-roster/preview?month=2026-12').expect(200),d=r.body.days.find(x=>x.date===body.date);assert(d.places['하림'].some(x=>Number(x.employee_id)===2&&!x.annotationOnly));assert(d.places['동우'].some(x=>Number(x.employee_id)===1&&!x.annotationOnly));
 assert(r.body.days.find(x=>x.date==='2026-12-08').places['하림'].some(x=>Number(x.employee_id)===1&&x.shift==='조출'));
 }finally{await db.close()}});

test('weekday swap rejects an ineligible night replacement and rolls back',async()=>{const {db,app}=await setup();try{
 await db.exec("UPDATE monthly_workplace_assignments SET workplace='동우' WHERE month='2026-12-01' AND employee_id=2");
 await request(app).put('/api/weekly-shift').send({month:'2026-12',workplace:'하림',shift:'야간',week_start:'2026-12-07',slot:1,employee_id:1}).expect(200);
 await request(app).post('/api/workplace-support/swap').send({date:'2026-12-07',employee_id:1,other_employee_id:2}).expect(409);
 assert.equal((await db.query("SELECT count(*)::int n FROM weekly_shift_overrides WHERE work_date='2026-12-07'")).rows[0].n,0);
 assert.equal((await db.query("SELECT count(*)::int n FROM daily_workplace_support WHERE work_date='2026-12-07'")).rows[0].n,0);
 }finally{await db.close()}});

test('changing a holiday support worker leaves the original assignment intact on failure',async()=>{const {db,app}=await setup();try{
 await db.exec("UPDATE monthly_workplace_assignments SET workplace='동우' WHERE month='2026-12-01' AND employee_id IN (1,2); UPDATE holiday_preferences SET status='available' WHERE employee_id=2");
 const date='2026-12-05',assignment={month:'2026-12',date,workplace:'하림',shift:'주간',slot:2,employee_id:1};
 await request(app).put('/api/workplace-support').send({date,employee_id:1,workplace:'하림'}).expect(200);
 await request(app).put('/api/holiday-plan/assignment').send(assignment).expect(200);
 await db.exec("UPDATE holiday_preferences SET status='unavailable' WHERE employee_id=2");
 const body={...assignment,employee_id:2,replace_support_employee_id:1};const r=await request(app).put('/api/holiday-plan/assignment').send(body).expect(409);assert(r.body.warning);
 assert.equal(Number((await db.query("SELECT employee_id FROM holiday_plan_assignments WHERE work_date='2026-12-05'")).rows[0].employee_id),1);
 await request(app).put('/api/holiday-plan/assignment').send({...body,confirm_unavailable:true}).expect(200);
 assert.equal(Number((await db.query("SELECT employee_id FROM holiday_plan_assignments WHERE work_date='2026-12-05'")).rows[0].employee_id),2);
 assert.deepEqual((await db.query("SELECT employee_id FROM daily_workplace_support WHERE work_date='2026-12-05'")).rows.map(x=>Number(x.employee_id)),[2]);
 }finally{await db.close()}});

test('holiday swap moves a weekly night duty only for the selected date',async()=>{const {db,app}=await setup();try{
 await db.exec("UPDATE monthly_workplace_assignments SET workplace='앤에프' WHERE month='2026-12-01' AND employee_id=1; UPDATE monthly_workplace_assignments SET workplace='동우' WHERE month='2026-12-01' AND employee_id=2; UPDATE holiday_preferences SET status='available',night_status='allowed' WHERE employee_id=2");
 await db.exec("INSERT INTO holiday_dates(holiday_date,label) VALUES('2026-12-04','휴일'); INSERT INTO holiday_preferences(holiday_id,employee_id,status,night_status) SELECT id,e,'available','allowed' FROM holiday_dates CROSS JOIN (VALUES(1),(2)) v(e) WHERE holiday_date='2026-12-04'");
 const date='2026-12-04';await request(app).put('/api/weekly-shift').send({month:'2026-12',workplace:'동우',shift:'야간',week_start:'2026-11-29',slot:1,employee_id:2}).expect(200);
 await request(app).put('/api/holiday-plan/assignment').send({month:'2026-12',date,workplace:'앤에프',shift:'주간',slot:1,employee_id:1}).expect(200);
 await request(app).post('/api/workplace-support/swap').send({date,employee_id:1,other_employee_id:2}).expect(200);
 assert.equal(Number((await db.query("SELECT employee_id FROM weekly_shift_assignments WHERE workplace='동우' AND shift='야간'")).rows[0].employee_id),2);
 assert.equal(Number((await db.query("SELECT employee_id FROM weekly_shift_overrides WHERE work_date='2026-12-04' AND workplace='동우' AND shift='야간'")).rows[0].employee_id),1);
 assert.equal(Number((await db.query("SELECT employee_id FROM holiday_plan_assignments WHERE work_date='2026-12-04' AND workplace='앤에프'")).rows[0].employee_id),2);
 }finally{await db.close()}});

test('weekday night swap allows an otherwise eligible worker with an outing',async()=>{const {db,app}=await setup();try{
 await db.exec("UPDATE monthly_workplace_assignments SET workplace='앤에프' WHERE month='2026-12-01' AND employee_id=1; UPDATE monthly_workplace_assignments SET workplace='동우' WHERE month='2026-12-01' AND employee_id=2; INSERT INTO attendance(employee_id,type,start_date,end_date,start_time,end_time,note) VALUES(1,'외출','2026-12-07','2026-12-07','13:00','14:00','')");
 await request(app).put('/api/weekly-shift').send({month:'2026-12',workplace:'동우',shift:'야간',week_start:'2026-12-06',slot:1,employee_id:2}).expect(200);
 await request(app).post('/api/workplace-support/swap').send({date:'2026-12-07',employee_id:1,other_employee_id:2}).expect(200);
 assert.equal(Number((await db.query("SELECT employee_id FROM weekly_shift_overrides WHERE work_date='2026-12-07' AND workplace='동우' AND shift='야간'")).rows[0].employee_id),1);
 }finally{await db.close()}});
