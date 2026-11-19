
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {keys,lockPeriods}=require('../period-locks');

test('period keys include every affected month',()=>{
 assert.deepEqual(
  keys('attendance','2026-12-29','2027-02-02'),
  ['attendance:2026-12','attendance:2027-01','attendance:2027-02']
 );
});

test('locks are deterministic, unique and transaction scoped',async()=>{
 const calls=[];
 const client={
  query:async(sql,args)=>{calls.push({sql,args})}
 };
 await lockPeriods(client,[
  'holiday:2027-02',
  'attendance:2027-01',
  'holiday:2027-02',
  'attendance:2026-12'
 ]);
 assert.deepEqual(
  calls.map(c=>c.args[1]),
  ['attendance:2026-12','attendance:2027-01','holiday:2027-02']
 );
 assert.ok(calls.every(c=>c.sql.includes('pg_advisory_xact_lock')));
});
