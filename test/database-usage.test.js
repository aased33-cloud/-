'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),request=require('supertest'),attach=require('../extra-routes');
function setup(role,bytes){
 let queries=0;const app=express();
 const user=(req,res,next)=>{if(role==='anonymous')return res.sendStatus(401);req.user={role};next()};
 const admin=(req,res,next)=>req.user.role==='admin'?next():res.sendStatus(403);
 const wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(()=>res.status(500).json({error:'failed'}));
 attach(app,{query:async sql=>{queries++;assert.match(sql,/sum\(pg_database_size\(datname\)\)/);return {rows:[{bytes}]}}},user,admin,wrap);
 return {app,queries:()=>queries};
}
test('capacity metric is available only to an authenticated administrator',async()=>{
 for(const [role,status] of [['anonymous',401],['employee',403]]){const s=setup(role,'400000000');await request(s.app).get('/api/database-usage').expect(status);assert.equal(s.queries(),0)}
 const s=setup('admin','400000000');const r=await request(s.app).get('/api/database-usage').expect(200);assert.equal(r.body.bytes,400000000);assert.equal(r.headers['cache-control'],'no-store');
});
test('missing or invalid usage is an error rather than an apparent zero',async()=>{
 for(const bytes of [null,'invalid','-1']){const s=setup('admin',bytes);await request(s.app).get('/api/database-usage').expect(500)}
});
