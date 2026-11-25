'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),r=require('../shift-rules');
test('night weeks use workplace-specific days and include cross-month dates',()=>{
 assert.deepEqual(r.weeks('2027-01','하림','야간')[0],{start:'2026-12-28',end:'2027-01-02'});
 assert.deepEqual(r.weeks('2027-01','동우','야간')[0],{start:'2026-12-27',end:'2027-01-01'});
 assert.equal(r.weeks('2027-01','하림','야간').length,5);assert.equal(r.shiftSpec('하림','조출').slots,1);
});
test('weekday attendance except outings excludes night candidates',()=>{
 const rows=[{type:'외출',start_date:'2026-12-28',end_date:'2026-12-28'}];assert.equal(r.hasAttendance(rows,'2026-12-28','2027-01-02',true),false);assert.equal(r.hasAttendance(rows,'2026-12-28','2027-01-02',false),true);
 rows.push({type:'병가',start_date:'2026-12-29',end_date:'2026-12-29'});assert.equal(r.hasAttendance(rows,'2026-12-28','2027-01-02',true),true);
 assert.equal(r.hasAttendance([{type:'연차',start_date:'2027-01-02',end_date:'2027-01-02'}],'2026-12-28','2027-01-02',true),false);
});
test('night pools follow monthly base workplace',()=>{assert.equal(r.inNightPool('앤에프','동우'),true);assert.equal(r.inNightPool('앤에프','하림'),false);assert.equal(r.inNightPool('싱그린','하림'),true);assert.equal(r.inNightPool(null,'하림'),false)});
test('week count belongs to the month with at least three weekdays',()=>{assert.equal(r.countMonth('2026-12-28'),'2026-12');assert.equal(r.countMonth('2026-12-30'),'2027-01');assert.equal(r.countMonth('2026-12-27'),'2026-12')});
