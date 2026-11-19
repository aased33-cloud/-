'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../rules');
test('Seoul calendar date is independent of server timezone',()=>{assert.equal(R.seoulDate(new Date('2026-11-19T15:05:00Z')),'2026-11-20')});
test('months covers both start and end months',()=>{assert.deepEqual(R.months('2026-11-29','2027-01-02'),['2026-11','2026-12','2027-01'])});
test('rejects invalid dates and attendance types',()=>{assert.equal(R.validDate('2026-02-30'),false);assert.throws(()=>R.validate({type:'반차',start_date:'2026-11-19',end_date:'2026-11-19'}))});
test('valid leave and timed early exit',()=>{assert.doesNotThrow(()=>R.validate({type:'연차',start_date:'2026-11-19',end_date:'2026-11-20'}));assert.doesNotThrow(()=>R.validate({type:'조퇴',start_date:'2026-11-19',end_date:'2026-11-19',start_time:'13:00',end_time:'17:00'}))});
test('rejects invalid early exit time',()=>{assert.throws(()=>R.validate({type:'조퇴',start_date:'2026-11-19',end_date:'2026-11-19',start_time:'17:00',end_time:'13:00'}))});
