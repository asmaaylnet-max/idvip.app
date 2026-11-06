import {fail,hmac,now,randomToken,type Env,type UserRow} from '../security';
export interface Predicate {sql:string;args?:unknown[];}
export const staffSQL=(actor:UserRow):Predicate=>({sql:"EXISTS(SELECT 1 FROM users WHERE id=? AND status='active' AND role IN ('owner','principal','moderator'))",args:[actor.id]});
export const rootSQL=(actor:UserRow):Predicate=>({sql:"EXISTS(SELECT 1 FROM users WHERE id=? AND status='active' AND role IN ('owner','principal'))",args:[actor.id]});
export function and(...predicates:Predicate[]):Predicate{return{sql:predicates.map(p=>`(${p.sql})`).join(' AND '),args:predicates.flatMap(p=>p.args??[])};}
export interface AuditMeta {actor:string;action:string;object:string;outcome?:string;}
export function gate(eventId:string){return{sql:'EXISTS(SELECT 1 FROM audit_events WHERE id=?)',args:[eventId]};}
export async function auditedBatch(env:Env,meta:AuditMeta,predicate:Predicate,statements:(eventId:string)=>D1PreparedStatement[]):Promise<string>{
 const id=randomToken(24),time=now();
 for(let attempt=0;attempt<5;attempt++){
 const previous=await env.DB.prepare('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1').first<{hash:string}>();const prev=previous?.hash??'GENESIS';
 const actor=await hmac(env,'audit-actor:'+meta.actor),object=await hmac(env,'audit-object:'+meta.object),outcome=meta.outcome??'success';
 const hash=await hmac(env,JSON.stringify({id,actor,action:meta.action,object,outcome,createdAt:time,prevHash:prev}));
 const insert=env.DB.prepare(`INSERT INTO audit_events(id,actor,action,object,outcome,created_at,prev_hash,hash) SELECT ?,?,?,?,?,?,?,? WHERE COALESCE((SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1),'GENESIS')=? AND (${predicate.sql})`).bind(id,actor,meta.action,object,outcome,time,prev,hash,prev,...predicate.args??[]);
 try{const results=await env.DB.batch([insert,...statements(id)]);if(results[0].meta.changes===1)return id;}catch(e){if(!(e instanceof Error)||!e.message.includes('audit_chain_conflict'))throw e;}
 const stillValid=await env.DB.prepare(`SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS ok`).bind(...predicate.args??[]).first<{ok:number}>();if(!stillValid?.ok)fail('CONFLICT',409);
 }
 fail('CONFLICT',409);
}
export async function auditOnly(env:Env,meta:AuditMeta){return auditedBatch(env,meta,{sql:'1'},()=>[]);}
