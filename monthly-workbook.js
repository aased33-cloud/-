'use strict';
const ExcelJS=require('exceljs'),path=require('node:path');
const template=path.join(__dirname,'templates','blank-roster.xlsx');
const {shiftRows,compose,color}=require('./public/roster-layout');
const textColors={normal:'FF20242E',leave:'FFC02636',support:'FF1756B2'};
function setEntries(cell,entries){
 const colors=entries.map(color);
 if(!entries.length){cell.value=null;return}
 if(colors.every(c=>c===colors[0])){cell.value=entries.map(compose).join(', ');cell.font={...cell.font,color:{argb:textColors[colors[0]]}}}
 else{const base={...cell.font};cell.value={richText:entries.flatMap((e,i)=>[...(i?[{font:{...base,color:{argb:'FF20242E'}},text:', '}]:[]),{font:{...base,color:{argb:textColors[color(e)]}},text:compose(e)}])}}
 cell.alignment={...cell.alignment,vertical:'middle',wrapText:true};
 // The template has fixed row heights; expand a row when several names or
 // attendance details would otherwise be clipped in an Excel viewer.
 const text=entries.map(compose).join(', '),width=Math.max(3,Number(cell.worksheet.getColumn(cell.col).width)||10);
 const units=[...text].reduce((n,ch)=>n+(ch.charCodeAt(0)>255?2:1),0);
 const lines=Math.max(1,Math.ceil(units/width));
 const row=cell.worksheet.getRow(cell.row);row.height=Math.max(row.height||0,lines*12);
}
function setPairedCell(sheet,row,col,entries){
 const left=sheet.getCell(row,col),right=sheet.getCell(row,col+1),special=entries.length===1&&entries[0].fridaySpecial;
 if(right.isMerged&&right.master.address===left.address&&special)sheet.unMergeCells(row,col,row,col+1);
 if(!special&&(!right.isMerged||right.master.address!==left.address)){try{sheet.mergeCells(row,col,row,col+1)}catch{}}
 if(special){left.value='22:30 ~ 07:30';setEntries(sheet.getCell(row,col+1),entries)}else setEntries(left,entries);
}
async function makeWorkbook(roster){
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(template);const a=wb.worksheets[0],b=wb.worksheets[1],[year,month]=roster.month.split('-').map(Number),first=new Date(Date.UTC(year,month-1,1)).getUTCDay();
 a.getCell('A1').value=`${year}년 ${month}월 근무편성표(하림·싱그린·정다운·중앙축산)`;b.getCell('A1').value=`${year}년 ${month}월 근무편성표(동우·앤에프)`;
 for(let week=0;week<6;week++)for(let day=0;day<7;day++){const vertical=Math.floor(week/2),side=week%2,letter=['일','월','화','수','목','금','토'][day];a.getCell(3+vertical*23,(side?14:4)+day).value=letter;b.getCell(3+vertical*11,(side?20:3)+day*2).value=letter}
 for(const day of roster.days){const n=Number(day.date.slice(8)),idx=Math.floor((first+n-1)/7),side=idx%2,vertical=Math.floor(idx/2),weekday=day.weekday,rowA=vertical*23,colA=(side?14:4)+weekday,rowB=vertical*11,colB=(side?20:3)+weekday*2;
  const dateA=a.getCell(4+rowA,colA),dateB=b.getCell(4+rowB,colB),dayColor=day.weekday===0||day.isPublicHoliday?'FFC02636':day.weekday===6?'FF1756B2':'FF20242E';for(const c of [dateA,dateB,a.getCell(3+rowA,colA),b.getCell(3+rowB,colB)])c.font={...c.font,color:{argb:dayColor}};dateA.numFmt='0';dateB.numFmt='0';dateA.value=n;dateB.value=n;
  for(const workplace of ['하림','싱그린','정다운','중앙축산'])for(const [r,items] of shiftRows(day.places[workplace],workplace)){const cell=a.getCell(r+rowA,colA);setEntries(cell,items)}
  for(const workplace of ['동우','앤에프'])for(const [r,items] of shiftRows(day.places[workplace],workplace))setPairedCell(b,r+rowB,colB,items);
 }
 return Buffer.from(await wb.xlsx.writeBuffer());
}
module.exports={makeWorkbook,shiftRows};
