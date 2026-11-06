import {type Env,type UserRow,now,randomToken,fail} from '../security';
import {auditedBatch,and,gate,rootSQL,type Predicate} from './audit';
interface DeletionJob{id:string;user_id:string;object_keys:string;attempts:number;}
export async function finishDeletion(env:Env,job:DeletionJob){
 await env.DB.prepare('UPDATE deletion_jobs SET attempts=attempts+1 WHERE id=?').bind(job.id).run();
 const lateMedia=await env.DB.prepare('SELECT object_key FROM media WHERE user_id=?').bind(job.user_id).all<{object_key:string}>();
 const keys=[...new Set([...(JSON.parse(job.object_keys) as string[]),...lateMedia.results.map(m=>m.object_key)])];
 if(keys.length&&!env.MEDIA)return false;
 try{for(let start=0;start<keys.length;start+=100)await env.MEDIA!.delete(keys.slice(start,start+100));}catch{return false;}
 const user=await env.DB.prepare('SELECT email FROM users WHERE id=? AND status=\'deleting\'').bind(job.user_id).first<{email:string}>();
 await env.DB.batch([
 env.DB.prepare('DELETE FROM otp_challenges WHERE email=?').bind(user?.email??''),
 env.DB.prepare('DELETE FROM email_outbox WHERE to_email=?').bind(user?.email??''),
 env.DB.prepare('DELETE FROM slug_reservations WHERE email=?').bind(user?.email??''),
 env.DB.prepare('DELETE FROM invitations WHERE email=? OR invited_by=? OR accepted_by=?').bind(user?.email??'',job.user_id,job.user_id),
 env.DB.prepare("DELETE FROM users WHERE id=? AND status='deleting'").bind(job.user_id),
 env.DB.prepare('DELETE FROM deletion_jobs WHERE id=?').bind(job.id)
 ]);return true;
}
export async function deleteUser(env:Env,actor:UserRow,targetId:string,admin=false,sessionHash?:string){
 const existing=await env.DB.prepare('SELECT * FROM deletion_jobs WHERE user_id=?').bind(targetId).first<DeletionJob>();if(existing)return finishDeletion(env,existing);
 const target=await env.DB.prepare("SELECT id,role FROM users WHERE id=? AND status='active'").bind(targetId).first<{id:string;role:string}>();if(!target)fail('NOT_FOUND',404);
 const medias=await env.DB.prepare('SELECT object_key FROM media WHERE user_id=?').bind(targetId).all<{object_key:string}>();const id=randomToken(24),time=now();
 if(medias.results.length&&!env.MEDIA)fail('SERVICE_UNAVAILABLE',503);
 const authorization:Predicate=admin?rootSQL(actor):{sql:"EXISTS(SELECT 1 FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.user_id=? AND s.auth_at>? AND u.status='active')",args:[sessionHash??'',actor.id,time-300]};
 await auditedBatch(env,{actor:actor.id,action:admin?'admin.user_delete':'account.delete',object:targetId},and(authorization,{sql:"EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')",args:[targetId]}),eventId=>{const g=gate(eventId);return[
 env.DB.prepare(`INSERT INTO deletion_jobs(id,user_id,object_keys,created_at) SELECT ?,?,?,? WHERE ${g.sql}`).bind(id,targetId,JSON.stringify(medias.results.map(m=>m.object_key)),time,...g.args??[]),
 env.DB.prepare(`UPDATE users SET status='deleting' WHERE id=? AND ${g.sql}`).bind(targetId,...g.args??[]),
 env.DB.prepare(`UPDATE sites SET visible=0,discoverable=0,status='hidden' WHERE owner_id=? AND ${g.sql}`).bind(targetId,...g.args??[]),
 env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND ${g.sql}`).bind(targetId,...g.args??[])
 ];});return finishDeletion(env,{id,user_id:targetId,object_keys:JSON.stringify(medias.results.map(m=>m.object_key)),attempts:0});
}
export async function resumeDeletions(env:Env,limit=1){const jobs=await env.DB.prepare('SELECT * FROM deletion_jobs ORDER BY created_at LIMIT ?').bind(limit).all<DeletionJob>();for(const job of jobs.results)await finishDeletion(env,job);}
