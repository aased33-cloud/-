'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {main}=require('../cleanup-audit');

test('cleanup cannot connect or delete unless explicitly enabled',async()=>{
 let connected=false;
 await main({env:{DATABASE_URL:'test'},createPool:()=>{connected=true;throw Error('must not connect')},log:()=>{}});
 assert.equal(connected,false);
});

test('cleanup deletes only audit rows older than six months and releases connection',async()=>{
 const calls=[];let ended=false;
 await main({env:{DATABASE_URL:'test',AUDIT_RETENTION_DELETE_ENABLED:'true'},createPool:options=>{
  assert.equal(options.ssl.rejectUnauthorized,true);
  return {query:async sql=>{calls.push(sql);return {rowCount:2}},end:async()=>{ended=true}};
 },log:()=>{}});
 assert.deepEqual(calls,["DELETE FROM audit_log WHERE created_at < now() - interval '6 months'"]);
 assert.equal(ended,true);
});

test('cleanup fails without a database URL and releases connection on query failure',async()=>{
 await assert.rejects(main({env:{AUDIT_RETENTION_DELETE_ENABLED:'true'},log:()=>{}}),/DATABASE_URL/);
 let ended=false;
 await assert.rejects(main({env:{DATABASE_URL:'test',AUDIT_RETENTION_DELETE_ENABLED:'true'},createPool:()=>({query:async()=>{throw Error('test failure')},end:async()=>{ended=true}}),log:()=>{}}),/test failure/);
 assert.equal(ended,true);
});
