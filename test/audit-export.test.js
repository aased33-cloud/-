'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const request=require('supertest');
const attach=require('../extra-routes');

function setup(role='admin',rows=[]){
 const calls=[];
 const app=express();
 const user=(req,res,next)=>{if(role==='anonymous')return res.status(401).json({error:'login'});req.user={id:1,role};next()};
 const admin=(req,res,next)=>req.user.role==='admin'?next():res.status(403).json({error:'admin'});
 const wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(()=>res.status(500).json({error:'failed'}));
 const pool={query:async(sql,params)=>{calls.push({sql,params});return {rows}}};
 attach(app,pool,user,admin,wrap);
 return {app,calls};
}

test('audit export returns all rows using a single snapshot query',async()=>{
 const entries=Array.from({length:125},(_,i)=>({id:i+1,actor_name:'가상직원'+i}));
 const {app,calls}=setup('admin',entries);
 const res=await request(app).get('/api/audit-export').query({from:'2026-11-01',to:'2026-11-30'}).expect(200);
 assert.deepEqual(res.body.rows,entries);
 assert.equal(res.headers['cache-control'],'no-store');
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].params,['2026-11-01','2026-11-30']);
 assert.match(calls[0].sql,/AT TIME ZONE 'Asia\/Seoul'/);
 assert.match(calls[0].sql,/ORDER BY a\.created_at DESC,a\.id DESC/);
 assert.doesNotMatch(calls[0].sql,/\b(?:LIMIT|OFFSET)\b/i);
});

test('audit export rejects invalid dates and reversed periods',async()=>{
 const {app,calls}=setup();
 for(const query of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-12-01',to:'2026-11-30'},{from:'2026-11-01'}])
  await request(app).get('/api/audit-export').query(query).expect(400);
 assert.equal(calls.length,0);
});

test('audit export requires an authenticated administrator',async()=>{
 for(const [role,status] of [['anonymous',401],['employee',403]]){
  const {app,calls}=setup(role);
  await request(app).get('/api/audit-export').query({from:'2026-11-01',to:'2026-11-30'}).expect(status);
  assert.equal(calls.length,0);
 }
});
