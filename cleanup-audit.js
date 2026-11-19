'use strict';
// Run daily via a reliable external scheduler (not an in-process timer on Render Free).
const {Pool}=require('pg');
async function main(){
 if(process.env.AUDIT_RETENTION_DELETE_ENABLED!=='true'){console.log('Audit cleanup disabled. Set AUDIT_RETENTION_DELETE_ENABLED=true after retention-policy approval.');return}
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is missing');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='disable'?false:{rejectUnauthorized:true}});
 try{const r=await pool.query("DELETE FROM audit_log WHERE created_at < now() - interval '6 months'");console.log('Audit cleanup completed. Deleted rows:',r.rowCount)}finally{await pool.end()}
}
main().catch(e=>{console.error('Audit cleanup failed:',e.message);process.exitCode=1});
