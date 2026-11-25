'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),request=require('supertest'),attach=require('../extra-routes');
function setup(role='admin',fail=false){
 const app=express();app.use(express.json());const calls=[];let released=false;
 const client={query:async(sql,args)=>{calls.push({sql,args});if(fail&&sql.startsWith('INSERT INTO audit_log'))throw Error('failed');return {rowCount:2}},release:()=>{released=true}};
 const pool={query:async sql=>{calls.push({sql});return {rows:[{count:2}]}},connect:async()=>client};
 const user=(req,res,next)=>{if(role==='anonymous')return res.sendStatus(401);req.user={id:7,role};next()};const admin=(req,res,next)=>req.user.role==='admin'?next():res.sendStatus(403);
 attach(app,pool,user,admin,fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(()=>res.sendStatus(500)));
 return {app,calls,released:()=>released};
}
test('only administrators can preview and manually delete old audit records',async()=>{
 for(const [role,status] of [['anonymous',401],['employee',403]]){const x=setup(role);await request(x.app).get('/api/audit-cleanup-preview').expect(status);await request(x.app).post('/api/audit-cleanup').send({confirm:true}).expect(status);assert.equal(x.calls.length,0)}
 const x=setup();const preview=await request(x.app).get('/api/audit-cleanup-preview').expect(200);assert.equal(preview.body.count,2);
 await request(x.app).post('/api/audit-cleanup').send({}).expect(400);assert.equal(x.calls.length,1);
 const r=await request(x.app).post('/api/audit-cleanup').send({confirm:true}).expect(200);assert.equal(r.body.deleted,2);assert.deepEqual(x.calls.slice(1).map(c=>c.sql.split(' ')[0]),['BEGIN','DELETE','INSERT','COMMIT']);assert.match(x.calls[2].sql,/DELETE FROM audit_log WHERE created_at < now\(\) - interval '6 months'/);assert.equal(x.calls[3].args[0],7);assert.equal(x.released(),true);
});
test('failed audit of cleanup rolls back the deletion',async()=>{
 const x=setup('admin',true);await request(x.app).post('/api/audit-cleanup').send({confirm:true}).expect(500);assert.equal(x.calls.at(-1).sql,'ROLLBACK');assert.equal(x.released(),true);
});
