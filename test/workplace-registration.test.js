'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite'),express=require('express'),request=require('supertest'),fs=require('node:fs'),path=require('node:path');
const attach=require('../workplace-routes');

async function setup(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;
 CREATE TABLE employees(id bigint PRIMARY KEY,name text,employee_no text,active boolean);
 CREATE TABLE attendance(id bigserial PRIMARY KEY,employee_id bigint,type text,start_date date,end_date date,start_time time,end_time time,note text);
 CREATE TABLE audit_log(id bigserial,actor_id bigint,action text,record_id bigint,before_data jsonb,after_data jsonb,created_at timestamptz DEFAULT now());
 INSERT INTO employees VALUES(1,'관리자','A001',true),(2,'직원','A002',true),(3,'비활성','A003',false);`);
 const migration=fs.readFileSync(path.join(__dirname,'../migration.sql'),'utf8');
 await db.exec(migration);await db.exec(migration); // existing migrations are repeatable
 const client={query:(...args)=>db.query(...args).then(r=>({...r,rowCount:String(args[0]).trim().startsWith('SELECT')?r.rows.length:(r.affectedRows??r.rows.length)})),release:()=>{}};
 const pool={query:client.query,connect:async()=>client},app=express();app.use(express.json());
 const user=(req,res,next)=>{const role=req.get('x-test-role')||'admin';if(role==='anonymous')return res.sendStatus(401);req.user={id:role==='employee'?2:1,role};next()};
 const admin=(req,res,next)=>req.user.role==='admin'?next():res.sendStatus(403);
 const wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>{console.error(e);res.sendStatus(500)});
 attach(app,pool,user,admin,wrap);require('../shift-routes')(app,pool,user,admin,wrap);return {db,app};
}

test('month assignments copy only empty active employees and preserve older months',async()=>{
 const {db,app}=await setup();try{
  await request(app).put('/api/workplaces/2').send({month:'2026-11',workplace:'하림'}).expect(200);
  const copied=await request(app).post('/api/workplaces/copy-previous').send({month:'2026-12'}).expect(200);assert.equal(copied.body.copied,1);
  await request(app).put('/api/workplaces/2').send({month:'2026-12',workplace:'동우'}).expect(200);
  const previous=await request(app).get('/api/workplaces?month=2026-11').expect(200);assert.equal(previous.body.assignments[0].workplace,'하림');
  const again=await request(app).post('/api/workplaces/copy-previous').send({month:'2026-12'}).expect(200);assert.equal(again.body.copied,0);
  const current=await request(app).get('/api/workplaces?month=2026-12').expect(200);assert.equal(current.body.assignments[0].workplace,'동우');
  await request(app).put('/api/workplaces/3').send({month:'2026-12',workplace:'하림'}).expect(400);
  await request(app).put('/api/workplaces/2').send({month:'2026-12',workplace:'잘못된 작업장'}).expect(400);
  await request(app).get('/api/workplaces?month=2026-12').set('x-test-role','employee').expect(403);
  const own=await request(app).get('/api/my-workplace?month=2026-12').set('x-test-role','employee').expect(200);assert.equal(own.body.workplace,'동우');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n,3);
 }finally{await db.close()}
});

test('employee can confirm no attendance only inside the registration window and when no entry exists',async()=>{
 const {db,app}=await setup();try{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),month=today.slice(0,7),date=month+'-01';
  await request(app).put('/api/registration-attendance/none').set('x-test-role','employee').send({month}).expect(403);
  await db.query("INSERT INTO monthly_deadlines(kind,month,start_date,deadline_date) VALUES('attendance',$1::date,$2::date,$2::date)",[date,today]);
  await request(app).put('/api/registration-attendance/none').set('x-test-role','employee').send({month}).expect(200);
  let r=await request(app).get('/api/registration-attendance').set('x-test-role','employee').query({month}).expect(200);assert.equal(r.body.no_attendance,true);
  await db.query("INSERT INTO attendance(employee_id,type,start_date,end_date,note) VALUES(2,'연차',$1::date,$1::date,'')",[date]);
  await request(app).put('/api/registration-attendance/none').set('x-test-role','employee').send({month}).expect(409);
  r=await request(app).get('/api/registration-attendance').set('x-test-role','employee').query({month}).expect(200);assert.equal(r.body.no_attendance,false);assert.equal(r.body.items.length,1);
 }finally{await db.close()}
});

test('night selection uses assigned workplace and shares crossing weeks across months',async()=>{
 const {db,app}=await setup();try{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  await db.query("INSERT INTO monthly_deadlines(kind,month,start_date,deadline_date) VALUES('attendance','2026-12-01',$1::date,$1::date),('attendance','2027-01-01',$1::date,$1::date)",[today]);
  await db.exec("INSERT INTO monthly_workplace_assignments(month,employee_id,workplace) VALUES('2026-12-01',2,'하림'),('2027-01-01',2,'하림')");
  let r=await request(app).get('/api/night-registration?month=2027-01').set('x-test-role','employee').expect(200);assert.equal(r.body.workplace,'하림');assert.deepEqual(r.body.weeks[0],{start:'2026-12-28',end:'2027-01-02',unavailable:false});
  await request(app).put('/api/night-registration').set('x-test-role','employee').send({month:'2027-01',week_start:'2026-12-28',unavailable:true}).expect(200);
  r=await request(app).get('/api/night-registration?month=2026-12').set('x-test-role','employee').expect(200);assert.equal(r.body.weeks.find(w=>w.start==='2026-12-28').unavailable,true);
  await request(app).put('/api/night-registration').set('x-test-role','employee').send({month:'2027-01',confirm:true}).expect(200);r=await request(app).get('/api/night-registration?month=2027-01').set('x-test-role','employee').expect(200);assert.equal(r.body.confirmed,true);
  await request(app).put('/api/night-registration').set('x-test-role','employee').send({month:'2027-01',week_start:'2026-11-01',unavailable:true}).expect(400);
  await request(app).put('/api/night-exclusions/2').set('x-test-role','employee').send({blocked:true}).expect(403);
  await request(app).put('/api/night-exclusions/2').send({blocked:true}).expect(200);r=await request(app).get('/api/night-registration?month=2027-01').set('x-test-role','employee').expect(200);assert.equal(r.body.blocked,true);assert.deepEqual(r.body.weeks,[]);
  await request(app).put('/api/night-registration').set('x-test-role','employee').send({month:'2027-01',confirm:true}).expect(403);
  await request(app).put('/api/night-exclusions/2').send({blocked:false}).expect(200);await db.exec("UPDATE monthly_workplace_assignments SET workplace='앤에프' WHERE month='2027-01-01' AND employee_id=2");
  r=await request(app).get('/api/night-registration?month=2027-01').set('x-test-role','employee').expect(200);assert.equal(r.body.workplace,'동우');assert.equal(r.body.weeks[0].start,'2026-12-27');assert.equal(r.body.weeks[0].end,'2027-01-01');
 }finally{await db.close()}
});

test('night assignment excludes blocked or unavailable employees and permits outings',async()=>{
 const {db,app}=await setup();try{
  await db.exec("INSERT INTO monthly_workplace_assignments(month,employee_id,workplace) VALUES('2026-12-01',1,'하림'),('2026-12-01',2,'싱그린');INSERT INTO attendance(employee_id,type,start_date,end_date,note) VALUES(2,'외출','2026-12-01','2026-12-01','');");
  const q={month:'2026-12',workplace:'하림',shift:'야간',week_start:'2026-11-30'};
  await request(app).get('/api/weekly-shift').set('x-test-role','employee').query(q).expect(403);
  let r=await request(app).get('/api/weekly-shift').query(q).expect(200);assert.equal(r.body.candidates.find(x=>Number(x.id)===2).reasons.length,0);
  await request(app).put('/api/weekly-shift').send({...q,slot:1,employee_id:2}).expect(200);
  await request(app).put('/api/weekly-shift').send({...q,slot:2,employee_id:2}).expect(409);
  await db.exec("INSERT INTO attendance(employee_id,type,start_date,end_date,note) VALUES(1,'병가','2026-12-01','2026-12-01','');");
  r=await request(app).get('/api/weekly-shift').query(q).expect(200);assert(r.body.candidates.find(x=>Number(x.id)===1).reasons.includes('해당 주 평일 근태'));
  await request(app).put('/api/weekly-shift').send({...q,slot:2,employee_id:1}).expect(409);
  await db.exec("DELETE FROM attendance WHERE employee_id=1;INSERT INTO employee_night_exclusions VALUES(1,true,now())");
  r=await request(app).get('/api/weekly-shift').query(q).expect(200);assert(r.body.candidates.find(x=>Number(x.id)===1).reasons.includes('관리자 야간 불가'));
  await request(app).put('/api/weekly-shift').send({...q,slot:2,employee_id:1}).expect(409);
  await request(app).put('/api/weekly-shift').send({...q,slot:1,employee_id:null}).expect(200);
 }finally{await db.close()}
});

test('date substitutes preserve weekly assignment, prevent duplicates, and count only three or more days',async()=>{
 const {db,app}=await setup();try{
  await db.exec("INSERT INTO monthly_workplace_assignments(month,employee_id,workplace) VALUES('2026-12-01',1,'하림'),('2026-12-01',2,'하림')");
  const q={month:'2026-12',workplace:'하림',shift:'조출',week_start:'2026-11-30'};
  await request(app).put('/api/weekly-shift').send({...q,slot:1,employee_id:1}).expect(200);
  await request(app).put('/api/weekly-shift/override').send({...q,slot:1,work_date:'2026-12-01',employee_id:2}).expect(200);
  let r=await request(app).get('/api/weekly-shift').query(q).expect(200);assert.equal(Number(r.body.assignments[0].employee_id),1);assert.equal(r.body.candidates.find(x=>Number(x.id)===2).current_count,0);
  await request(app).put('/api/weekly-shift/override').send({...q,slot:1,work_date:'2026-12-02',employee_id:2}).expect(200);
  await request(app).put('/api/weekly-shift/override').send({...q,slot:1,work_date:'2026-12-03',employee_id:2}).expect(200);
  r=await request(app).get('/api/weekly-shift').query(q).expect(200);assert.equal(r.body.candidates.find(x=>Number(x.id)===2).current_count,0.5);assert.equal(r.body.candidates.find(x=>Number(x.id)===1).current_count,1);
  await request(app).put('/api/weekly-shift').send({...q,slot:1,employee_id:null}).expect(409);
  await db.exec("INSERT INTO attendance(employee_id,type,start_date,end_date,note) VALUES(2,'연차','2026-12-04','2026-12-04','')");
  await request(app).put('/api/weekly-shift/override').send({...q,slot:1,work_date:'2026-12-04',employee_id:2}).expect(409);
  await request(app).put('/api/weekly-shift/override').send({...q,slot:1,work_date:'2026-12-01',reset:true,employee_id:null}).expect(200);
  r=await request(app).get('/api/weekly-shift').query(q).expect(200);assert.equal(r.body.candidates.find(x=>Number(x.id)===2).current_count,0);
 }finally{await db.close()}
});

test('date replacement rejects another person already working the same date',async()=>{
 const {db,app}=await setup();try{
  await db.exec("INSERT INTO monthly_workplace_assignments(month,employee_id,workplace) VALUES('2026-12-01',1,'하림'),('2026-12-01',2,'하림')");
  const q={month:'2026-12',workplace:'하림',shift:'야간',week_start:'2026-11-30'};
  await request(app).put('/api/weekly-shift').send({...q,slot:1,employee_id:1}).expect(200);
  await request(app).put('/api/weekly-shift').send({...q,slot:2,employee_id:2}).expect(200);
  await request(app).put('/api/weekly-shift/override').send({...q,slot:1,work_date:'2026-12-01',employee_id:2}).expect(409);
  const r=await request(app).get('/api/weekly-shift').query(q).expect(200);assert.equal(r.body.overrides.length,0);
 }finally{await db.close()}
});
