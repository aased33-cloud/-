'use strict';
const {spawnSync}=require('child_process');const fs=require('fs');const path=require('path');
const raw=process.env.SUPABASE_CONNECTION_RETRY||process.env.DATABASE_URL;if(!raw){console.error('데이터베이스 연결 정보가 필요합니다.');process.exit(1)}
const u=new URL(raw);const allowed=['postgres:','postgresql:'];if(!allowed.includes(u.protocol)||!u.username||!u.password||!u.hostname||!u.pathname.slice(1)){console.error('연결 정보를 확인하세요.');process.exit(1)}
const ca=path.resolve(__dirname,'../prod-ca-2021.crt');if(!fs.existsSync(ca)){console.error('데이터베이스 인증서가 없습니다.');process.exit(1)}
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const out=path.resolve(__dirname,`../근태관리-백업-${date}.dump`);
const env={...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGSSLMODE:'verify-full',PGSSLROOTCERT:ca};
const args=['--format=custom','--no-owner','--no-privileges','--schema=public','--table=public.employees','--table=public.attendance','--table=public.audit_log','--table=public.monthly_deadlines','--table=public.holiday_dates','--table=public.holiday_preferences','--table=public.monthly_workplace_assignments','--table=public.attendance_registration_progress','--table=public.employee_night_exclusions','--table=public.night_unavailable_weeks','--table=public.employee_shift_restrictions','--table=public.weekly_shift_assignments','--file',out];
const result=spawnSync('pg_dump',args,{env,encoding:'utf8',timeout:120000});if(result.error||result.status!==0){if(fs.existsSync(out))fs.unlinkSync(out);console.error('백업 생성 실패:',result.error?.code||`프로세스 오류 ${result.status}`);process.exit(1)}
console.log('백업 생성 완료:',path.basename(out));console.log('크기:',fs.statSync(out).size,'바이트');
