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
 attach(app,pool,user,admin,wrap);return {db,app};
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
