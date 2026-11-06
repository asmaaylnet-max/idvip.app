import {BRAND,type Lang} from '../../shared/types';
import {type Env,type UserRow,fail,now} from '../security';
import {auditedBatch,and,gate,type Predicate} from './audit';
import {enqueueEmail,deliverEmail,type EmailMessage} from './email';

export interface CustodyRow {user_id:string;admin_id:string;created_at:number;}
/** Receipt is allowed even if the former administrator was demoted/deleted. */
export async function custodyForUser(env:Env,userId:string):Promise<CustodyRow|null> {
 return env.DB.prepare("SELECT c.* FROM custody c JOIN users u ON u.id=c.user_id WHERE c.user_id=? AND u.status='active' AND COALESCE(u.verified_at,0)=0").bind(userId).first<CustodyRow>();
}
export async function custodyConsentForEmail(env:Env,email:string):Promise<boolean> {
 return !!await env.DB.prepare("SELECT c.user_id FROM custody c JOIN users u ON u.id=c.user_id WHERE u.email=? AND u.status='active' AND COALESCE(u.verified_at,0)=0").bind(email).first();
}
/** Include this in EACH managed mutating SQL, not only a route preflight. */
export function custodySQL(adminId:string,userId:string):Predicate {
 return {sql:"EXISTS(SELECT 1 FROM custody c JOIN users target ON target.id=c.user_id JOIN users actor ON actor.id=c.admin_id WHERE c.user_id=? AND c.admin_id=? AND actor.status='active' AND actor.role IN ('owner','principal') AND target.status='active' AND target.role='user' AND COALESCE(target.verified_at,0)=0)",args:[userId,adminId]};
}
export async function isCustodian(env:Env,adminId:string,userId:string):Promise<boolean> {
 const p=custodySQL(adminId,userId);
 return !!(await env.DB.prepare(`SELECT CASE WHEN (${p.sql}) THEN 1 ELSE 0 END AS ok`).bind(...p.args??[]).first<{ok:number}>())?.ok;
}
export function custodyReceiptSQL(userId:string,expected:CustodyRow|null):Predicate {
 return expected?{sql:"EXISTS(SELECT 1 FROM custody c JOIN users u ON u.id=c.user_id WHERE c.user_id=? AND c.admin_id=? AND c.created_at=? AND u.status='active' AND COALESCE(u.verified_at,0)=0)",args:[userId,expected.admin_id,expected.created_at]}:{sql:'NOT EXISTS(SELECT 1 FROM custody WHERE user_id=?)',args:[userId]};
}
export function custodyReceiptStatements(env:Env,eventId:string,userId:string):D1PreparedStatement[] {
 const g=gate(eventId);
 return [env.DB.prepare(`DELETE FROM custody WHERE user_id=? AND ${g.sql}`).bind(userId,...g.args)];
}
export function managedOutboxId(userId:string){return `managed-invite:${userId}`;}
export function managedInvitation(email:string,locale:Lang):EmailMessage {
 const en=locale==='en',url=`https://auth.${BRAND.domain}/login`;
 const subject=en?'Your managed VIP account is ready to receive':'دعوة لاستلام حسابك المُدار في VIP';
 const intro=en?'VIP administration prepared a professional account and website for this email. Until you receive it, its administrator can edit and submit its profile. To receive this same account, sign in with an email code, explicitly accept receipt, agree to the terms and confirm you are 18 or older. Receipt ends the administrator’s draft control. Never share your verification code. If you did not expect this invitation, ignore it or contact support.':'جهزت إدارة VIP حساباً وموقعاً مهنياً لهذا البريد. يستطيع المدير تحرير الملف وإرساله للمراجعة حتى استلامك. لاستلام الحساب نفسه، ادخل برمز البريد واقبل الاستلام والشروط وأكد أن عمرك 18 عاماً أو أكثر. ينتهي تحكم المدير بالمسودة عند الاستلام. لا تشارك رمز التحقق. إن لم تتوقع هذه الدعوة فتجاهلها أو تواصل مع الدعم.';
 return {from:BRAND.sender,to:email,replyTo:BRAND.support,subject,text:`${subject}\n${intro}\n${url}`,html:`<!doctype html><html lang="${locale}" dir="${en?'ltr':'rtl'}"><body><h1>${subject}</h1><p>${intro}</p><a href="${url}">${en?'Receive your account':'استلام الحساب'}</a></body></html>`};
}
/** Encrypt via the existing enqueueEmail contract, then insert its exact payload in an audited transaction. */
export async function inviteManaged(env:Env,actor:UserRow,target:UserRow) {
 const id=managedOutboxId(target.id),existing=await env.DB.prepare('SELECT id FROM email_outbox WHERE id=?').bind(id).first();
 if(!existing){
  let values:unknown[]=[];
  const captureDB={prepare:()=>({bind:(...args:unknown[])=>({run:async()=>{values=args;return {success:true};}})})} as unknown as D1Database;
  await enqueueEmail({...env,DB:captureDB},id,managedInvitation(target.email,target.locale),now()+86400);
  if(values.length!==7)fail('SERVICE_UNAVAILABLE',503);
  const p=custodySQL(actor.id,target.id);
  await auditedBatch(env,{actor:actor.id,action:'managed.invite_enqueue',object:id},and(p,{sql:'NOT EXISTS(SELECT 1 FROM email_outbox WHERE id=?)',args:[id]}),eventId=>{
   const g=gate(eventId);
   return [env.DB.prepare(`INSERT INTO email_outbox(id,to_email,payload_cipher,state,created_at,updated_at,next_attempt_at,expires_at) SELECT ?,?,?,'pending',?,?,?,? WHERE ${p.sql} AND ${g.sql}`).bind(...values,...p.args??[],...g.args)];
  });
 }
 // Recheck on retries as well; stable provider idempotency key comes from the existing outbox.
 if(!await isCustodian(env,actor.id,target.id))fail('NOT_FOUND',404);
 const result=await deliverEmail(env,id);
 return {outboxId:id,emailAccepted:result.accepted,emailUnknown:result.unknown};
}
