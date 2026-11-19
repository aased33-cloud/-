'use strict';
// Serialize deadline edits and employee writes for the same kind/month.
// PostgreSQL transaction advisory locks are released on COMMIT/ROLLBACK.
const {months}=require('./rules');
function keys(kind, start, end=start){return months(start,end).map(month=>`${kind}:${month}`)}
async function lockPeriods(client, keysToLock){
  for(const key of [...new Set(keysToLock)].sort()){
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',['attendance-period-v1',key]);
  }
}
module.exports={keys,lockPeriods};
