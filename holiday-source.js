'use strict';
const {validDate}=require('./rules');
const ENDPOINT='https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
function parseHolidayResponse(json,month){
 const r=json?.response;if(!['00','0'].includes(String(r?.header?.resultCode)))throw Error('공휴일 정보 제공처가 정상 응답하지 않았습니다.');
 const body=r.body,total=Number(body?.totalCount);if(!Number.isSafeInteger(total)||total<0)throw Error('공휴일 응답을 확인할 수 없습니다.');
 const raw=body?.items?.item,items=raw==null?[]:Array.isArray(raw)?raw:[raw];if(items.length!==total)throw Error('공휴일 정보를 모두 받지 못했습니다.');
 const result=new Map();for(const item of items){
  if(item.isHoliday!=='Y')continue;const value=String(item.locdate||''),date=value.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'),name=String(item.dateName||'').trim();
  if(!validDate(date)||!date.startsWith(month)||!name||name.length>80)throw Error('공휴일 날짜 또는 이름을 확인할 수 없습니다.');
  if(new Date(date+'T00:00:00Z').getUTCDay()!==0&&!result.has(date))result.set(date,name);
 }return [...result].map(([date,label])=>({date,label}));
}
function createHolidaySource({pool,key,fetcher=fetch,now=Date.now}){
 const cache=new Map();
 return async function sync(month){
  if(!key)return {status:'unconfigured'};const last=cache.get(month);if(last&&last.until>now())return last.promise;
  const promise=(async()=>{try{
   const url=new URL(ENDPOINT);url.searchParams.set('serviceKey',key);url.searchParams.set('solYear',month.slice(0,4));url.searchParams.set('solMonth',month.slice(5,7));url.searchParams.set('_type','json');url.searchParams.set('numOfRows','100');
   const response=await fetcher(url,{signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('upstream unavailable');
   const holidays=parseHolidayResponse(await response.json(),month);
   if(holidays.length){const values=[],params=[];for(const h of holidays){params.push(h.date,h.label);values.push(`($${params.length-1}::date,$${params.length})`)}await pool.query(`INSERT INTO holiday_dates(holiday_date,label) VALUES ${values.join(',')} ON CONFLICT(holiday_date) DO NOTHING`,params)}
   return {status:'ok',count:holidays.length};
  }catch(e){return {status:'error'}}})();
  cache.set(month,{until:now()+6*60*60*1000,promise});
  promise.then(result=>{if(result.status==='error'&&cache.get(month)?.promise===promise)cache.set(month,{until:now()+300000,promise:Promise.resolve(result)})});
  return promise;
 };
}
module.exports={parseHolidayResponse,createHolidaySource};
