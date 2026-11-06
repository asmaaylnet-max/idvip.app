import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { BRAND, type User, type Lang, type Role } from '../shared/types';
import { z } from 'zod';

export interface Env {
 DB: D1Database; MEDIA?: R2Bucket; RESEND_API_KEY?: string; SESSION_SECRET: string;
 PUBLIC_ORIGIN: string; COOKIE_MODE: 'preview'|'production'; RP_ID?: string;
 EMAIL?: { send(message: {from:string;to:string;subject:string;html:string;text:string;replyTo:string}): Promise<unknown> };
 VAPID_PUBLIC_KEY?:string;VAPID_PRIVATE_KEY?:string;VAPID_SUBJECT?:string;PUSH_ENABLED?:string;PUSH_ALLOWED_PROVIDERS?:string;
}
export interface SessionRow { token_hash:string;user_id:string;csrf:string;created_at:number;expires_at:number;auth_at:number; }
export interface UserRow { id:string;email:string;name:string;role:Role;public_id:number;locale:Lang;password_hash:string|null;status:string;verified_at:number;created_at:number; }
export type AppEnv = {Bindings:Env;Variables:{user:UserRow|null;session:SessionRow|null;locale:Lang}};
export type Ctx = Context<AppEnv>;
export const now = () => Math.floor(Date.now()/1000);
export class HttpError extends Error { constructor(public status:400|401|403|404|409|413|415|429|503, public code:string){super(code);} }
const messages:Record<string,[string,string]> = {
 INVALID_INPUT:['تحقق من البيانات المدخلة.','Please check the submitted data.'], UNAUTHORIZED:['يرجى تسجيل الدخول.','Please sign in.'], FORBIDDEN:['لا تملك صلاحية هذا الإجراء.','You are not allowed to perform this action.'],
 ORIGIN:['مصدر الطلب غير مسموح. افتح المنصة من رابطها المعتمد.','This origin is not allowed. Open the platform at its trusted URL.'], CSRF:['انتهت صلاحية حماية الطلب. حدّث الصفحة.','Request protection expired. Refresh the page.'],
 NOT_FOUND:['العنصر غير متاح.','This item is unavailable.'], CONFLICT:['تغيرت البيانات. حدّث الصفحة وحاول مجدداً.','Data changed. Refresh and try again.'],
 RATE_LIMIT:['طلبات كثيرة. انتظر قليلاً ثم أعد المحاولة.','Too many requests. Please wait and try again.'], EMAIL_UNAVAILABLE:['إرسال البريد غير متاح حالياً. لم يُؤكّد إرسال رسالة.','Email sending is unavailable. No email acceptance was confirmed.'],
 EMAIL_UNKNOWN:['تعذر تأكيد قبول البريد. أعد محاولة الطلب نفسه، أو استخدم الرمز إن وصل.','Email acceptance is uncertain. Retry the same request, or use the code if it arrives.'],
 OTP_INVALID:['الرمز غير صحيح أو منتهي.','The code is invalid or expired.'], SLUG_UNAVAILABLE:['الاسم محجوز أو غير مسموح.','This name is reserved or unavailable.'],
 PASSWORD_WEAK:['الرمز يجب أن يحتوي 13 محرفاً على الأقل ورقماً وحرفاً كبيراً وصغيراً.','Use at least 13 characters including a number, an uppercase and a lowercase letter.'],
 STEP_UP:['أكّد دخولك مجدداً بالرمز أو مفتاح المرور لإتمام الإجراء.','Confirm your sign-in again with a code or passkey to continue.'],
 MEDIA_INVALID:['ارفع صورة WebP صالحة بحجم لا يتجاوز 8 ميغابايت وأبعاد مسموحة.','Upload a valid WebP image up to 8 MiB within the allowed dimensions.'],
 MEDIA_CONVERT:['حوّل صورة JPG أو PNG إلى WebP قبل الرفع.','Convert the JPG or PNG image to WebP before uploading.'],
 MEDIA_OWNERSHIP:['لا يمكن ربط وسيط يخص حساباً آخر.','You cannot attach another account’s media.'], PRIVACY_REVIEW:['زيادة الحقول الظاهرة تحتاج موافقة على نسخة جديدة.','Revealing additional fields requires approval of a new version.'],
 SERVICE_UNAVAILABLE:['الخدمة غير مهيأة أو غير متاحة حالياً.','The service is not configured or is unavailable.'], PASSKEY_INVALID:['لم نتمكن من التحقق من مفتاح المرور. حاول مجدداً.','Passkey verification failed. Please try again.'],
 INVITATION:['الدعوة غير صالحة أو تتطلب قبولاً صريحاً.','The invitation is invalid or requires explicit acceptance.'], DELETE_PENDING:['أوقف الحساب وبقي تنظيف بعض الملفات. أعد المحاولة لإكمال الحذف.','The account was disabled; some files still need cleanup. Retry to finish deletion.']
};
export function localized(code:string,lang:Lang='ar'){return (messages[code]??messages.SERVICE_UNAVAILABLE)[lang==='en'?1:0];}
export function fail(code:string,status:HttpError['status']=400):never {throw new HttpError(status,code);}
export function localeFor(c:Ctx):Lang {return c.get('locale')??(c.req.header('X-Locale')==='en'?'en':'ar');}
export async function body<T extends z.ZodTypeAny>(c:Ctx,schema:T):Promise<z.infer<T>> {
 if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) fail('INVALID_INPUT');
 if(Number(c.req.header('Content-Length')??0)>300_000) fail('INVALID_INPUT',413);
 let data:unknown;try {const text=await c.req.text();if(text.length>300_000)fail('INVALID_INPUT',413);data=JSON.parse(text);}catch(e){if(e instanceof HttpError)throw e;fail('INVALID_INPUT');}
 if(data&&typeof data==='object'&&'locale' in data){const language=(data as {locale:unknown}).locale;if(language==='ar'||language==='en')c.set('locale',language);}
 const parsed=schema.safeParse(data);if(!parsed.success)fail('INVALID_INPUT');return parsed.data;
}
const encoder=new TextEncoder();
export function bytesToBase64(bytes:Uint8Array){let str='';for(const b of bytes)str+=String.fromCharCode(b);return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function fromBase64(value:string):Uint8Array<ArrayBuffer>{const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
export function randomToken(bytes=32){return bytesToBase64(crypto.getRandomValues(new Uint8Array(bytes)));}
export function randomPIN(){const max=4294000000;let n:number;do{n=crypto.getRandomValues(new Uint32Array(1))[0];}while(n>=max);return String(n%1000000).padStart(6,'0');}
export async function sha256(value:string){return bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));}
export function requireSecret(env:Env){if(!env.SESSION_SECRET||env.SESSION_SECRET.length<32)fail('SERVICE_UNAVAILABLE',503);}
export async function hmac(env:Env,value:string){requireSecret(env);const key=await crypto.subtle.importKey('raw',encoder.encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value))));}
export function constantTime(a:string,b:string){let diff=a.length^b.length;const length=Math.max(a.length,b.length);for(let i=0;i<length;i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
export const PASSWORD_ITERATIONS=100_000;
export function validPassword(value:string){return value.length>=13&&value.length<=256&&/[a-z]/.test(value)&&/[A-Z]/.test(value)&&/[0-9]/.test(value);}
async function derivePassword(env:Env,password:string,salt:Uint8Array<ArrayBuffer>,iterations:number){
 const pepper=await hmac(env,'password:'+password);const key=await crypto.subtle.importKey('raw',encoder.encode(pepper),'PBKDF2',false,['deriveBits']);
 return bytesToBase64(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,256)));
}
export async function hashPassword(env:Env,password:string){if(!validPassword(password))fail('PASSWORD_WEAK');const salt=crypto.getRandomValues(new Uint8Array(16));return `pbkdf2-sha256$v1$${PASSWORD_ITERATIONS}$${bytesToBase64(salt)}$${await derivePassword(env,password,salt,PASSWORD_ITERATIONS)}`;}
export async function verifyPassword(env:Env,password:string,hash:string){const parts=hash.split('$');if(parts.length!==5||parts[0]!=='pbkdf2-sha256'||parts[1]!=='v1'||Number(parts[2])!==PASSWORD_ITERATIONS||password.length>256)return false;try{return constantTime(await derivePassword(env,password,fromBase64(parts[3]),Number(parts[2])),parts[4]);}catch{return false;}}
export const RESERVED_SLUGS = new Set(['www','api','auth','admin','account','login','logout','register','signup','recover','support','ceo','mail','smtp','imap','webmail','settings','sites','media','search','blogs','blog','notifications','audit','test','demo','privacy','terms','about','contact','help','status','assets','brand','fonts','static','cdn','dashboard','c','idvip','vip','cloudflare','resend','owner','principal','moderator','root','security','payment','billing','null','undefined','system','gov','government','police','bank','saudi','ksa']);
export function validSlug(slug:string){return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)&&!RESERVED_SLUGS.has(slug)&&!slug.startsWith('xn--')&&!/^(?:admin|support|security|idvip|gov|bank)[-_]/.test(slug);}
export const TRUSTED_HOSTS=new Set([BRAND.domain,'www.'+BRAND.domain,'admin.'+BRAND.domain,'account.'+BRAND.domain,'auth.'+BRAND.domain,'login.'+BRAND.domain,'register.'+BRAND.domain]);
export function trustedOrigin(env:Env,origin:string|undefined,currentURL:string):boolean {
 if(!origin||origin==='null')return false;
 try{const incoming=new URL(origin),current=new URL(currentURL),configured=new URL(env.PUBLIC_ORIGIN);
 if(incoming.origin!==origin||incoming.username||incoming.password)return false;
 if(env.COOKIE_MODE==='production')return incoming.protocol==='https:'&&TRUSTED_HOSTS.has(incoming.hostname)&&!incoming.port&&(incoming.origin===current.origin||incoming.origin===configured.origin||TRUSTED_HOSTS.has(incoming.hostname));
 return incoming.origin===configured.origin&&incoming.origin===current.origin&&['https:','http:'].includes(incoming.protocol)&&(incoming.protocol==='https:'||['localhost','127.0.0.1'].includes(incoming.hostname));
 }catch{return false;}
}
export function requireOrigin(c:Ctx){if(!platformRequest(c)||!trustedOrigin(c.env,c.req.header('Origin'),c.req.url))fail('ORIGIN',403);}
export function platformRequest(c:Ctx){try{const current=new URL(c.req.url),origin=new URL(c.env.PUBLIC_ORIGIN);return c.env.COOKIE_MODE==='production'?current.protocol==='https:'&&TRUSTED_HOSTS.has(current.hostname):current.origin===origin.origin;}catch{return false;}}
export function publicUser(row:UserRow,hasPasskey=false):User{return{id:row.id,email:row.email,name:row.name,role:row.role,publicId:row.public_id,hasPassword:!!row.password_hash,hasPasskey};}
export async function getSession(request:Request,env:Env):Promise<{user:UserRow;session:SessionRow}|null>{
 let trusted=false;try{const url=new URL(request.url);trusted=env.COOKIE_MODE==='production'?url.protocol==='https:'&&TRUSTED_HOSTS.has(url.hostname)&&!url.port:url.origin===new URL(env.PUBLIC_ORIGIN).origin;}catch{return null;}
 if(!trusted||!env.DB)return null;const token=/(?:^|;\s*)__Host-vip_session=([A-Za-z0-9_-]{20,128})(?:;|$)/.exec(request.headers.get('Cookie')??'')?.[1];if(!token)return null;
 const session=await env.DB.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').bind(await sha256(token),now()).first<SessionRow>();if(!session)return null;
 const user=await env.DB.prepare("SELECT * FROM users WHERE id=? AND status='active'").bind(session.user_id).first<UserRow>();return user?{user,session}:null;
}
export const initialize:MiddlewareHandler<AppEnv>=async(c,next)=>{
 c.set('locale',c.req.header('X-Locale')==='en'?'en':'ar');c.set('user',null);c.set('session',null);
 c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');
 const verified=await getSession(c.req.raw,c.env);if(verified){c.set('user',verified.user);c.set('session',verified.session);}
 await next();
};
export const authenticated:MiddlewareHandler<AppEnv>=async(c,next)=>{if(!platformRequest(c))fail('ORIGIN',403);if(!c.get('user'))fail('UNAUTHORIZED',401);if(!['GET','HEAD','OPTIONS'].includes(c.req.method)){requireOrigin(c);const session=c.get('session');if(!session||!constantTime(session.csrf,c.req.header('X-CSRF-Token')??''))fail('CSRF',403);}await next();};
export const staff:MiddlewareHandler<AppEnv>=async(c,next)=>{if(!['owner','principal','moderator'].includes(c.get('user')?.role??''))fail('FORBIDDEN',403);await next();};
export const root:MiddlewareHandler<AppEnv>=async(c,next)=>{if(!['owner','principal'].includes(c.get('user')?.role??''))fail('FORBIDDEN',403);await next();};
export function stepUp(c:Ctx){const session=c.get('session');if(!session||session.auth_at<now()-300)fail('STEP_UP',403);}
export function setSessionCookie(c:Ctx,token:string){setCookie(c,'__Host-vip_session',token,{path:'/',httpOnly:true,secure:true,sameSite:c.env.COOKIE_MODE==='preview'?'None':'Lax',maxAge:60*60*24*30});}
export function clearSessionCookie(c:Ctx){deleteCookie(c,'__Host-vip_session',{path:'/',secure:true,httpOnly:true,sameSite:c.env.COOKIE_MODE==='preview'?'None':'Lax'});}
export async function createSession(c:Ctx,user:UserRow){requireSecret(c.env);const token=randomToken(),hash=await sha256(token),csrf=randomToken(),time=now();const old=c.get('session');const statements=[c.env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,created_at,expires_at,auth_at) SELECT ?,id,?,?,?,? FROM users WHERE id=? AND status=\'active\'').bind(hash,csrf,time,time+30*86400,time,user.id)];if(old)statements.push(c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(old.token_hash));const result=await c.env.DB.batch(statements);if(!result[0].meta.changes)fail('UNAUTHORIZED',401);setSessionCookie(c,token);c.set('user',user);c.set('session',{token_hash:hash,user_id:user.id,csrf,created_at:time,expires_at:time+30*86400,auth_at:time});return csrf;}
export async function rateLimit(env:Env,key:string,max:number,seconds:number){const time=now(),window=Math.floor(time/seconds)*seconds;const row=await env.DB.prepare('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count').bind(await hmac(env,'rate:'+key),window).first<{count:number}>();if(!row||row.count>max)fail('RATE_LIMIT',429);}
export async function requestLimit(c:Ctx,bucket:string,max=30,seconds=60){await rateLimit(c.env,`${bucket}:${c.req.header('CF-Connecting-IP')??'local'}`,max,seconds);}
export function csvCell(value:unknown){const str=String(value??'');const safe=/^[\s]*[=+\-@\t\r]/.test(str)?"'"+str:str;return '"'+safe.replace(/"/g,'""')+'"';}
