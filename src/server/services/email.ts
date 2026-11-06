import {BRAND,type Lang} from '../../shared/types';
import {bytesToBase64,fromBase64,sha256,now,fail,type Env} from '../security';
export interface EmailMessage {from:string;to:string;subject:string;html:string;text:string;replyTo:string;}
interface Outbox {id:string;to_email:string;payload_cipher:string;state:string;provider:string|null;attempts:number;uncertain:number;created_at:number;expires_at:number;lease_until:number|null;next_attempt_at:number;}
function escapeHTML(value:string){return value.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));}
export function otpEmail(email:string,pin:string,locale:Lang,name='',invitation=false):EmailMessage {
 const en=locale==='en',title=en?'Your VIP verification code':'رمز التحقق الخاص بك في VIP';
 const intro=en?`Welcome${name?' '+name:''}. Use this code to securely ${invitation?'accept your VIP invitation':'access your VIP account'}.`:`مرحباً${name?' '+name:''}. استخدم هذا الرمز ${invitation?'لقبول دعوتك في VIP بأمان':'للدخول الآمن إلى حسابك في VIP'}.`;
 const caution=en?'Valid for 10 minutes. Never share this code. If you did not request it, ignore this email.':'صالح لمدة 10 دقائق. لا تشارك الرمز مع أحد. إن لم تطلبه فتجاهل هذه الرسالة.';
 const support=en?'Reply to this email for support.':'للدعم يمكنك الرد على هذه الرسالة.';
 return{from:BRAND.sender,to:email,replyTo:BRAND.support,subject:title,text:`${intro}\n\n${pin}\n\n${caution}\n${support}\nhttps://${BRAND.domain}`,html:`<!doctype html><html lang="${locale}" dir="${en?'ltr':'rtl'}"><head><meta charset="utf-8"></head><body style="margin:0;background:#11100f;font-family:Arial,sans-serif;color:#f4ead4"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:30px 12px"><table role="presentation" width="560" style="max-width:100%;border:1px solid #b49a61;border-radius:22px;overflow:hidden;background:#1b1815"><tr><td><img alt="VIP" width="560" src="https://${BRAND.domain}/brand/cover-dark-768.webp" style="width:100%;display:block"></td></tr><tr><td style="text-align:center;padding:26px"><img alt="VIP" src="https://${BRAND.domain}/brand/logo-dark-192.webp" width="112" style="display:block;margin:0 auto 20px"><h1 style="font-size:24px;color:#ddc595">${title}</h1><p style="line-height:1.8">${escapeHTML(intro)}</p><div dir="ltr" style="font-size:38px;letter-spacing:9px;font-weight:bold;border:1px solid #b49a61;border-radius:14px;padding:22px;color:#f9e6bc">${pin}</div><p style="font-size:14px;line-height:1.8;color:#cec0a8">${caution}</p><p style="font-size:14px">${support}</p><a href="https://${BRAND.domain}" style="color:#ddc595;text-decoration:none">${BRAND.domain}</a></td></tr></table></td></tr></table></body></html>`};
}
async function encryptionKey(env:Env){return crypto.subtle.importKey('raw',fromBase64(await sha256('outbox:'+env.SESSION_SECRET)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
async function encrypt(env:Env,value:EmailMessage){const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await encryptionKey(env),new TextEncoder().encode(JSON.stringify(value))));return bytesToBase64(iv)+'.'+bytesToBase64(cipher);}
async function decrypt(env:Env,value:string):Promise<EmailMessage>{const[iv,data]=value.split('.');const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(iv)},await encryptionKey(env),fromBase64(data));return JSON.parse(new TextDecoder().decode(plain)) as EmailMessage;}
export async function enqueueEmail(env:Env,id:string,message:EmailMessage,expiresAt:number){const time=now();await env.DB.prepare("INSERT INTO email_outbox(id,to_email,payload_cipher,state,created_at,updated_at,next_attempt_at,expires_at) VALUES(?,?,?,'pending',?,?,?,?)").bind(id,message.to,await encrypt(env,message),time,time,time,expiresAt).run();}
export function canFallback(status:number,code:string){return(status===429&&['daily_quota_exceeded','monthly_quota_exceeded','rate_limit_exceeded'].includes(code))||([400,401,403,422].includes(status)&&['validation_error','missing_api_key','restricted_api_key','suspended_api_key','invalid_permission','missing_required_field','invalid_parameter'].includes(code));}
async function finish(env:Env,id:string,state:string,provider:string,code:string,providerId:string|null=null){const time=now();await env.DB.batch([
 env.DB.prepare('UPDATE email_outbox SET state=?,provider=?,provider_id=?,updated_at=?,next_attempt_at=?,lease_until=NULL,last_code=?,uncertain=CASE WHEN ?=\'unknown\' THEN 1 ELSE uncertain END,payload_cipher=CASE WHEN ?=\'accepted\' THEN \'\' ELSE payload_cipher END WHERE id=?').bind(state,provider,providerId,time,time+10,code,state,state,id),
 env.DB.prepare('UPDATE otp_challenges SET delivery_state=? WHERE id=?').bind(state==='accepted'?'accepted':state==='unknown'?'unknown':'failed',id)
 ]);}
export async function deliverEmail(env:Env,id:string):Promise<{accepted:boolean;unknown:boolean}> {
 const time=now();let outbox=await env.DB.prepare('SELECT * FROM email_outbox WHERE id=?').bind(id).first<Outbox>();if(!outbox)fail('EMAIL_UNAVAILABLE',503);
 if(outbox.state==='accepted')return{accepted:true,unknown:false};
 if(outbox.expires_at<=time||time-outbox.created_at>=86400)fail('EMAIL_UNAVAILABLE',503);
 if(outbox.provider==='binding'&&['unknown','sending'].includes(outbox.state))return{accepted:false,unknown:true};
 if(outbox.next_attempt_at>time||outbox.lease_until&&outbox.lease_until>time)return{accepted:false,unknown:true};
 const hadUncertainty=!!outbox.uncertain||outbox.state==='unknown'||(outbox.provider==='resend'&&outbox.state==='sending');
 if(hadUncertainty)await env.DB.prepare('UPDATE email_outbox SET uncertain=1 WHERE id=?').bind(id).run();
 const lock=await env.DB.prepare("UPDATE email_outbox SET state='sending',attempts=attempts+1,lease_until=?,updated_at=? WHERE id=? AND state<>'accepted' AND (lease_until IS NULL OR lease_until<=?) AND next_attempt_at<=? RETURNING *").bind(time+35,time,id,time,time).first<Outbox>();if(!lock)return{accepted:false,unknown:true};outbox=lock;
 await env.DB.prepare("UPDATE otp_challenges SET delivery_state='unknown' WHERE id=?").bind(id).run();
 const message=await decrypt(env,outbox.payload_cipher);
 const fallback=async()=>{
 if(!env.EMAIL){await finish(env,id,'failed','none','not_configured');return{accepted:false,unknown:false};}
 await env.DB.prepare("UPDATE email_outbox SET provider='binding' WHERE id=?").bind(id).run();
 try{await env.EMAIL.send(message);await finish(env,id,'accepted','binding','accepted');return{accepted:true,unknown:false};}catch{await finish(env,id,'unknown','binding','binding_exception');return{accepted:false,unknown:true};}
 };
 if(!env.RESEND_API_KEY){if(outbox.provider==='resend'){await finish(env,id,'unknown','resend','provider_missing_after_unknown');return{accepted:false,unknown:true};}return fallback();}
 await env.DB.prepare("UPDATE email_outbox SET provider='resend' WHERE id=?").bind(id).run();
 let response:Response;
 try{response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`vip-email/${id}`},body:JSON.stringify({from:message.from,to:[message.to],subject:message.subject,html:message.html,text:message.text,reply_to:message.replyTo}),signal:AbortSignal.timeout(15000)});}catch{await finish(env,id,'unknown','resend','network_unknown');return{accepted:false,unknown:true};}
 let result:{id?:string;name?:string};try{result=await response.json() as typeof result;}catch{await finish(env,id,'unknown','resend','response_unknown');return{accepted:false,unknown:true};}
 if(response.ok&&result.id){await finish(env,id,'accepted','resend','accepted',result.id);return{accepted:true,unknown:false};}
 const code=result.name??`http_${response.status}`;
 if(canFallback(response.status,code)&&env.EMAIL&&!hadUncertainty)return fallback();
 const unknown=hadUncertainty||response.status>=500||response.status===409||response.ok;
 await finish(env,id,unknown?'unknown':'failed','resend',code);return{accepted:false,unknown};
}
export async function pruneExpired(env:Env){const time=now();await env.DB.batch([
 env.DB.prepare('DELETE FROM email_outbox WHERE expires_at<? AND state<>\'sending\'').bind(time-3600),
 env.DB.prepare('DELETE FROM otp_challenges WHERE expires_at<?').bind(time-3600),
 env.DB.prepare('DELETE FROM slug_reservations WHERE expires_at<?').bind(time),
 env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(time),
 env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at<?').bind(time),
 env.DB.prepare('DELETE FROM rate_limits WHERE window_start<?').bind(time-86400)
 ]);}

export function reviewEmail(email:string,slug:string,locale:Lang,decision:'approve'|'reject'|'changes'|'suspend',note=''):EmailMessage {
 const en=locale==='en';const title={approve:en?'Your VIP website is published':'تم نشر موقعك في VIP',reject:en?'Your VIP request needs attention':'حالة طلبك في VIP',changes:en?'Changes requested for your VIP website':'مطلوب تعديل على موقعك في VIP',suspend:en?'Your VIP publication was suspended':'تم تعليق نشر موقعك في VIP'}[decision];
 const url=decision==='approve'?`https://${slug}.${BRAND.domain}/`:`https://auth.${BRAND.domain}/account`;
 const intro=en?'Your request has been reviewed. View your website or account for the current status.':'تمت مراجعة طلبك. يمكنك عرض موقعك أو متابعة الحالة من حسابك.';
 return {from:BRAND.sender,to:email,replyTo:BRAND.support,subject:title,text:`${title}\n${intro}\n${note}\n${url}`,html:`<!doctype html><html lang="${locale}" dir="${en?'ltr':'rtl'}"><body style="margin:0;padding:32px 12px;background:#11100f;color:#f4ead4;font-family:Arial,sans-serif"><main style="max-width:560px;margin:auto;padding:28px;border:1px solid #b49a61;border-radius:22px;background:#1b1815;text-align:center"><img alt="VIP" src="https://${BRAND.domain}/brand/logo-dark-192.webp" width="112"/><h1 style="font-size:24px;color:#ddc595">${title}</h1><p style="line-height:1.8">${intro}</p>${note?`<p style="line-height:1.8">${escapeHTML(note)}</p>`:''}<a href="${url}" style="display:inline-block;padding:16px 24px;border:1px solid #b49a61;border-radius:14px;color:#f9e6bc">${en?'View current status':'عرض الحالة الحالية'}</a><p style="font-size:14px">${en?'Reply to this message for support.':'يمكنك الرد على الرسالة للدعم.'}</p></main></body></html>`};
}
