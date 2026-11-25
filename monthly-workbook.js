'use strict';
const ExcelJS=require('exceljs'),path=require('node:path');
const template=path.join(__dirname,'templates','blank-roster.xlsx');
function compose(e){if(e.annotationOnly){const parts=[];if(e.destination)parts.push(e.destination);if(e.attendance)parts.push(e.attendance);return e.name+'('+parts.join(', ')+')'}return e.name+(e.attendance?'('+e.attendance+')':'')}
function fill(items,first,last){const rows=new Map();for(let r=first;r<=last;r++)rows.set(r,[]);const pending=[];for(const item of items){if(item.row!=null&&item.row>=first&&item.row<=last&&rows.get(item.row).length===0)rows.get(item.row).push(item);else pending.push(item)}for(const item of pending){const row=[...rows.keys()].find(r=>rows.get(r).length===0)??last;rows.get(row).push(item)}return rows}
function shiftRows(entries,workplace){
 const rows=new Map();const put=(row,e)=>{if(!rows.has(row))rows.set(row,[]);rows.get(row).push(e)};
 const group=(items,lo,hi)=>{for(const [r,list] of fill(items,lo,hi))for(const e of list)put(r,e)};
 if(workplace==='하림'){
  const early=entries.filter(e=>!e.annotationOnly&&(e.shift==='조출'||e.shift==='주간'&&Number(e.slot)===1));
  const night=entries.filter(e=>!e.annotationOnly&&e.shift==='야간').map(e=>({...e,row:16+Number(e.slot||1)}));
  const rest=entries.filter(e=>!early.includes(e)&&!(e.shift==='야간'&&!e.annotationOnly));
  group(early,5,5);group(rest,6,16);group(night,17,18);
 }else if(workplace==='싱그린'){
  const early=entries.filter(e=>!e.annotationOnly&&e.shift==='조출'),late=entries.filter(e=>!e.annotationOnly&&e.shift==='후출'),other=entries.filter(e=>!early.includes(e)&&!late.includes(e));group([...early,...other],19,19);group(late,20,20);
 }else if(workplace==='정다운')group(entries,21,22);
 else if(workplace==='중앙축산')group(entries,23,25);
 else if(workplace==='동우'){
  const late=entries.filter(e=>!e.annotationOnly&&e.shift==='후출'),night=entries.filter(e=>!e.annotationOnly&&e.shift==='야간').map(e=>({...e,row:9+Number(e.slot||1)})),rest=entries.filter(e=>!late.includes(e)&&!(e.shift==='야간'&&!e.annotationOnly));
  group(rest,5,8);group(late,9,9);group(night,10,11);
 }else if(workplace==='앤에프')group(entries,12,13);
 return rows;
}
function setPairedCell(sheet,row,col,entries){
 const left=sheet.getCell(row,col),right=sheet.getCell(row,col+1),special=entries.length===1&&entries[0].fridaySpecial;
 if(right.isMerged&&right.master.address===left.address&&special)sheet.unMergeCells(row,col,row,col+1);
 if(!special&&(!right.isMerged||right.master.address!==left.address)){try{sheet.mergeCells(row,col,row,col+1)}catch{}}
 left.value=special?'22:30 ~ 07:30':entries.map(compose).join(', ');
 if(special)sheet.getCell(row,col+1).value=compose(entries[0]);
}
async function makeWorkbook(roster){
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(template);const a=wb.worksheets[0],b=wb.worksheets[1],[year,month]=roster.month.split('-').map(Number),first=new Date(Date.UTC(year,month-1,1)).getUTCDay();
 a.getCell('A1').value=`${year}년 ${month}월 근무편성표(하림·싱그린·정다운·중앙축산)`;b.getCell('A1').value=`${year}년 ${month}월 근무편성표(동우·앤에프)`;
 for(let week=0;week<6;week++)for(let day=0;day<7;day++){const vertical=Math.floor(week/2),side=week%2,letter=['일','월','화','수','목','금','토'][day];a.getCell(3+vertical*23,(side?14:4)+day).value=letter;b.getCell(3+vertical*11,(side?20:3)+day*2).value=letter}
 for(const day of roster.days){const n=Number(day.date.slice(8)),idx=Math.floor((first+n-1)/7),side=idx%2,vertical=Math.floor(idx/2),weekday=day.weekday,rowA=vertical*23,colA=(side?14:4)+weekday,rowB=vertical*11,colB=(side?20:3)+weekday*2;
  const dateA=a.getCell(4+rowA,colA),dateB=b.getCell(4+rowB,colB);dateA.numFmt='0';dateB.numFmt='0';dateA.value=n;dateB.value=n;
  for(const workplace of ['하림','싱그린','정다운','중앙축산'])for(const [r,items] of shiftRows(day.places[workplace],workplace)){const cell=a.getCell(r+rowA,colA);cell.value=items.map(compose).join(', ')}
  for(const workplace of ['동우','앤에프'])for(const [r,items] of shiftRows(day.places[workplace],workplace))setPairedCell(b,r+rowB,colB,items);
 }
 return Buffer.from(await wb.xlsx.writeBuffer());
}
module.exports={makeWorkbook,shiftRows};
