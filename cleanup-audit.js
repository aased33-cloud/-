'use strict';
// Run daily via a reliable external scheduler (not an in-process timer on Render Free).
const {Pool}=require('pg');
async function main({env=process.env,createPool=options=>new Pool(options),log=console.log}={}){
 if(env.AUDIT_RETENTION_DELETE_ENABLED!=='true'){log('Audit cleanup disabled. Set AUDIT_RETENTION_DELETE_ENABLED=true to enable it.');return}
 if(!env.DATABASE_URL)throw Error('DATABASE_URL is missing');
 const pool=createPool({connectionString:env.DATABASE_URL,ssl:env.PGSSL==='disable'?false:{rejectUnauthorized:true}});
 try{const r=await pool.query("DELETE FROM audit_log WHERE created_at < now() - interval '6 months'");log('Audit cleanup completed. Deleted rows:',r.rowCount)}finally{await pool.end()}
}
if(require.main===module)main().catch(e=>{console.error('Audit cleanup failed:',e.message);process.exitCode=1});
module.exports={main};
