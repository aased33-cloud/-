'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite'),express=require('express'),request=require('supertest'),fs=require('node:fs'),path=require('node:path');
const attach=require('../extra-routes');
async function setup(){
 const db=new PGlite();await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE TABLE employees(id bigint PRIMARY KEY,name text,active boolean);CREATE TABLE audit_log(id bigserial,actor_id bigint,action text,record_id bigint,before_data jsonb,after_data jsonb,created_at timestamptz DEFAULT now());INSERT INTO employees VALUES(1,'관리자',true),(2,'직원',true);`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../migration.sql'),'utf8'));
 const client={query:(...a)=>db.query(...a).then(r=>({...r,rowCount:String(a[0]).trim().startsWith('SELECT')?r.rows.length:(r.affectedRows??r.rows.length)})),release:()=>{}};const pool={query:client.query,connect:async()=>client};const app=express();app.use(express.json());
 const user=(req,res,next)=>{const role=req.get('x-test-role')||'admin';req.user={id:role==='employee'?2:1,role};next()},admin=(req,res,next)=>req.user.role==='admin'?next():res.sendStatus(403),wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>{console.error(e);res.sendStatus(500)});attach(app,pool,user,admin,wrap);return {db,app};
}

test('shared deadlines update both periods together and reject invalid input',async()=>{
 const {db,app}=await setup();try{
  await db.query("INSERT INTO monthly_deadlines VALUES('attendance','2027-01-01','2026-12-01','2026-12-05'),('holiday','2027-01-01','2026-12-02','2026-12-06')");
  await request(app).put('/api/deadlines/common').set('x-test-role','employee').send({month:'2027-01',start_date:'2026-12-03',deadline_date:'2026-12-20'}).expect(403);
  await request(app).put('/api/deadlines/common').send({month:'2027-01',start_date:'2027-01-03',deadline_date:'2027-01-20'}).expect(400);
  const prior=(await db.query("SELECT kind,start_date::text s,deadline_date::text d FROM monthly_deadlines ORDER BY kind")).rows;assert.notEqual(prior[0].s,prior[1].s);
  await request(app).put('/api/deadlines/common').send({month:'2027-01',start_date:'2026-12-03',deadline_date:'2026-12-20'}).expect(200);
  const after=(await db.query("SELECT start_date::text s,deadline_date::text d FROM monthly_deadlines ORDER BY kind")).rows;assert.deepEqual(after,[{s:'2026-12-03',d:'2026-12-20'},{s:'2026-12-03',d:'2026-12-20'}]);
 }finally{await db.close()}
});

test('all-available updates day and night, preserves notes, skips exclusions, and respects authorization',async()=>{
 const {db,app}=await setup();try{
  await db.exec("INSERT INTO holiday_dates(id,holiday_date,label,excluded) VALUES(1,'2026-12-05','토요일',false),(2,'2026-12-12','토요일',false),(3,'2026-12-19','제외',true);INSERT INTO holiday_preferences(holiday_id,employee_id,status,night_status,note) VALUES(1,2,'unavailable','allowed','메모 보존'),(3,2,'unavailable','unavailable','기존');");
  await request(app).put('/api/holiday-preferences/bulk-available').set('x-test-role','employee').send({month:'2026-12',employee_id:1}).expect(403);
  const response=await request(app).put('/api/holiday-preferences/bulk-available').send({month:'2026-12',employee_id:2}).expect(200);assert.equal(response.body.changed,2);
  const rows=(await db.query('SELECT holiday_id,status,night_status,note FROM holiday_preferences WHERE employee_id=2 ORDER BY holiday_id')).rows;assert.deepEqual(rows.map(x=>[Number(x.holiday_id),x.status,x.night_status,x.note]),[[1,'available','allowed','메모 보존'],[2,'available','allowed',''],[3,'unavailable','unavailable','기존']]);
  const again=await request(app).put('/api/holiday-preferences/bulk-available').send({month:'2026-12',employee_id:2}).expect(200);assert.equal(again.body.changed,0);
 }finally{await db.close()}
});

test('employee can change unavailable to available within the open registration period',async()=>{const {db,app}=await setup();try{
 const today=require('../rules').seoulDate(),[y,m]=today.slice(0,7).split('-').map(Number),target=new Date(Date.UTC(y,m,1)).toISOString().slice(0,10),holiday=new Date(Date.UTC(y,m,5)).toISOString().slice(0,10);
 await db.query("INSERT INTO monthly_deadlines(kind,month,start_date,deadline_date) VALUES('holiday',$1::date,$2::date,$2::date)",[target,today]);
 const row=(await db.query("INSERT INTO holiday_dates(holiday_date,label) VALUES($1::date,'휴일') RETURNING id",[holiday])).rows[0];
 await request(app).put('/api/holiday-preferences/'+row.id).set('x-test-role','employee').send({status:'unavailable',night_status:'unavailable'}).expect(200);
 await request(app).put('/api/holiday-preferences/'+row.id).set('x-test-role','employee').send({status:'available',night_status:'allowed'}).expect(200);
 const pref=(await db.query('SELECT status,night_status FROM holiday_preferences WHERE holiday_id=$1 AND employee_id=2',[row.id])).rows[0];assert.deepEqual(pref,{status:'available',night_status:'allowed'});
 }finally{await db.close()}});
