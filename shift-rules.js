'use strict';
const TYPES={
 '하림:조출':{start:1,days:5,slots:1},'하림:야간':{start:1,days:6,slots:2},
 '동우:후출':{start:1,days:5,slots:1},'동우:야간':{start:0,days:6,slots:2},
 '싱그린:조출':{start:1,days:5,slots:1},'싱그린:후출':{start:1,days:5,slots:1}
};
function shiftSpec(workplace,kind){return TYPES[`${workplace}:${kind}`]||null}
function stamp(date){return date.toISOString().slice(0,10)}
function add(date,n){return stamp(new Date(Date.parse(date+'T00:00:00Z')+n*86400000))}
function weeks(month,workplace,kind){
 const spec=shiftSpec(workplace,kind);if(!spec||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return [];
 const [y,m]=month.split('-').map(Number),first=new Date(Date.UTC(y,m-1,1)),last=stamp(new Date(Date.UTC(y,m,0))),offset=(first.getUTCDay()-spec.start+7)%7;
 let date=stamp(new Date(Date.UTC(y,m-1,1-offset)));const out=[];while(date<=last){const end=add(date,spec.days-1);if(end>=stamp(first))out.push({start:date,end});date=add(date,7)}return out;
}
function isWeekday(s){const d=new Date(s+'T00:00:00Z').getUTCDay();return d>=1&&d<=5}
function hasAttendance(items,start,end,excludeOuting){
 return items.some(x=>{if(excludeOuting&&x.type==='외출')return false;const from=x.start_date>start?x.start_date:start,to=x.end_date<end?x.end_date:end;for(let d=from;d<=to;d=add(d,1))if(isWeekday(d))return true;return false});
}
function inNightPool(base,workplace){return workplace==='동우'?['동우','앤에프'].includes(base):!!base&&!['동우','앤에프'].includes(base)}
function countMonth(start){const count={};for(let i=0;i<7;i++){const date=add(start,i);if(isWeekday(date))count[date.slice(0,7)]=(count[date.slice(0,7)]||0)+1}return Object.keys(count).find(m=>count[m]>=3)||null}
module.exports={shiftSpec,weeks,add,hasAttendance,inNightPool,countMonth};
