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
function expansionFor(roster,workplaces,block){
 const extras=new Map(),[y,m]=roster.month.split('-').map(Number),first=new Date(Date.UTC(y,m-1,1)).getUTCDay();
 for(const day of roster.days){const n=Number(day.date.slice(8)),week=Math.floor((first+n-1)/7),v=Math.floor(week/2);for(const work of workplaces)for(const [r,items] of shiftRows(day.places[work]||[],work)){const row=r+v*block;extras.set(row,Math.max(extras.get(row)||0,items.length-1))}}
 for(const [r,n] of extras)if(!n)extras.delete(r);return extras;
}
function expandTemplate(wb,source,extras,isB){
 const map=r=>r+[...extras].reduce((n,[at,count])=>n+(at<r?count:0),0);
 if(!extras.size)return {sheet:source,map};
 const sheet=wb.addWorksheet(source.name+' (expanded)',{properties:{...source.properties},pageSetup:{...source.pageSetup},views:source.views.map(v=>({...v}))});
 for(let c=1;c<=source.columnCount;c++){const from=source.getColumn(c),to=sheet.getColumn(c);to.width=from.width;to.hidden=from.hidden;to.outlineLevel=from.outlineLevel}
 source.eachRow({includeEmpty:true},row=>{const dest=sheet.getRow(map(row.number));dest.height=row.height;dest.hidden=row.hidden;dest.outlineLevel=row.outlineLevel;row.eachCell({includeEmpty:true},cell=>{const out=dest.getCell(cell.col);out.style=structuredClone(cell.style);if(cell.type!==ExcelJS.ValueType.Merge)out.value=structuredClone(cell.value);if(cell.note)out.note=structuredClone(cell.note)})});
 for(const [old,count] of extras){const src=source.getRow(old),start=map(old);for(let j=1;j<=count;j++){const row=sheet.getRow(start+j);row.height=src.height;src.eachCell({includeEmpty:true},cell=>{const out=row.getCell(cell.col);out.style=structuredClone(cell.style);out.value=null})}}
 const decode=address=>{const m=/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(address);if(!m)throw Error('Invalid merge: '+address);const col=s=>[...s].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0);return {l:col(m[1]),t:+m[2],r:col(m[3]),b:+m[4]}};
 const merges=source.model.merges.map(decode);
 for(const a of merges){const extend=a.t<a.b?(extras.get(a.b)||0):0;sheet.mergeCells(map(a.t),a.l,map(a.b)+extend,a.r);if(a.t===a.b&&a.l!==a.r&&extras.has(a.t))for(let j=1;j<=extras.get(a.t);j++)sheet.mergeCells(map(a.t)+j,a.l,map(a.t)+j,a.r)}
 // Single-row labels for a band need to cover the inserted rows too.
 for(const [old,count] of extras){for(const col of isB?[1,2,18,19]:[2,3,12,13]){const cell=source.getCell(old,col);if(cell.isMerged)continue;if(cell.value!==null&&cell.value!==undefined)sheet.mergeCells(map(old),col,map(old)+count,col)}}
 if(sheet.pageSetup.printArea){const area=sheet.pageSetup.printArea;sheet.pageSetup.printArea=area.replace(/(\$?[A-Z]+\$?)(\d+)$/,(m,p,r)=>p+map(Number(r)))}
 return {sheet,map};
}
async function makeWorkbook(roster){
 const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(template);const origA=wb.worksheets[0],origB=wb.worksheets[1],expA=expandTemplate(wb,origA,expansionFor(roster,['하림','싱그린','정다운','중앙축산'],23),false),expB=expandTemplate(wb,origB,expansionFor(roster,['동우','앤에프'],11),true),a=expA.sheet,b=expB.sheet,mapA=expA.map,mapB=expB.map,[year,month]=roster.month.split('-').map(Number),first=new Date(Date.UTC(year,month-1,1)).getUTCDay();
 if(a!==origA){const name=origA.name;wb.removeWorksheet(origA.id);a.name=name}if(b!==origB){const name=origB.name;wb.removeWorksheet(origB.id);b.name=name}
 // Recreate in original sheet order when only the first sheet was expanded.
 if(wb.worksheets[0]!==a){a.orderNo=0;b.orderNo=1}
 a.getCell('A1').value=`${year}년 ${month}월 근무편성표(하림·싱그린·정다운·중앙축산)`;b.getCell('A1').value=`${year}년 ${month}월 근무편성표(동우·앤에프)`;
 for(let week=0;week<6;week++)for(let day=0;day<7;day++){const vertical=Math.floor(week/2),side=week%2,letter=['일','월','화','수','목','금','토'][day];a.getCell(mapA(3+vertical*23),(side?14:4)+day).value=letter;b.getCell(mapB(3+vertical*11),(side?20:3)+day*2).value=letter}
 for(const day of roster.days){const n=Number(day.date.slice(8)),idx=Math.floor((first+n-1)/7),side=idx%2,vertical=Math.floor(idx/2),weekday=day.weekday,rowA=vertical*23,colA=(side?14:4)+weekday,rowB=vertical*11,colB=(side?20:3)+weekday*2;
  const dateA=a.getCell(mapA(4+rowA),colA),dateB=b.getCell(mapB(4+rowB),colB),dayColor=day.weekday===0||day.isPublicHoliday?'FFC02636':day.weekday===6?'FF1756B2':'FF20242E';for(const c of [dateA,dateB,a.getCell(mapA(3+rowA),colA),b.getCell(mapB(3+rowB),colB)])c.font={...c.font,color:{argb:dayColor}};dateA.numFmt='0';dateB.numFmt='0';dateA.value=n;dateB.value=n;
  for(const workplace of ['하림','싱그린','정다운','중앙축산'])for(const [r,items] of shiftRows(day.places[workplace],workplace)){for(let i=0;i<items.length;i++)setEntries(a.getCell(mapA(r+rowA)+i,colA),[items[i]])}
  for(const workplace of ['동우','앤에프'])for(const [r,items] of shiftRows(day.places[workplace],workplace))items.forEach((item,i)=>setPairedCell(b,mapB(r+rowB)+i,colB,[item]));
 }
 return Buffer.from(await wb.xlsx.writeBuffer());
}
module.exports={makeWorkbook,shiftRows};
