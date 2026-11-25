'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseHolidayResponse,createHolidaySource}=require('../holiday-source');
const response=items=>({response:{header:{resultCode:'00'},body:{totalCount:items.length,items:{item:items}}}});
test('public holidays include substitute and temporary holidays but exclude Sundays',()=>{
 const data=response([{locdate:20261225,dateName:'공휴일',isHoliday:'Y'},{locdate:20261226,dateName:'임시공휴일',isHoliday:'Y'},{locdate:20261227,dateName:'일요일',isHoliday:'Y'},{locdate:20261228,dateName:'대체공휴일',isHoliday:'Y'}]);
 assert.deepEqual(parseHolidayResponse(data,'2026-12'),[{date:'2026-12-25',label:'공휴일'},{date:'2026-12-26',label:'임시공휴일'},{date:'2026-12-28',label:'대체공휴일'}]);
});
test('incomplete or invalid source response does not produce a partial calendar',()=>{
 assert.throws(()=>parseHolidayResponse({response:{header:{resultCode:'00'},body:{totalCount:2,items:{item:{locdate:20261225,dateName:'성탄절',isHoliday:'Y'}}}}},'2026-12'));
 assert.throws(()=>parseHolidayResponse({response:{header:{resultCode:'99'}}},'2026-12'));
});
test('source preserves existing and excluded dates and retries failures',async()=>{
 let calls=0,now=0,query=[];const pool={query:async(...args)=>query.push(args)},fetcher=async()=>{calls++;if(calls===1)throw Error('unavailable');return {ok:true,json:async()=>response([{locdate:20261225,dateName:'성탄절',isHoliday:'Y'}])}};
 const sync=createHolidaySource({pool,key:'synthetic',fetcher,now:()=>now});assert.equal((await sync('2026-12')).status,'error');assert.equal((await sync('2026-12')).status,'error');assert.equal(calls,1);now=300001;assert.equal((await sync('2026-12')).status,'ok');assert.equal(calls,2);assert.match(query[0][0],/ON CONFLICT\(holiday_date\) DO NOTHING/);assert.deepEqual(query[0][1],['2026-12-25','성탄절']);
});
test('unconfigured source does not perform network or database operations',async()=>{
 const sync=createHolidaySource({pool:{query:()=>{throw Error('unexpected')}},fetcher:()=>{throw Error('unexpected')},key:''});assert.equal((await sync('2026-12')).status,'unconfigured');
});
