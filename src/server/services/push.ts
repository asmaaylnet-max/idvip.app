import {type Env, hmac, now, randomToken, HttpError} from '../security';
import {auditedBatch, auditOnly, gate} from './audit';

/** No Node crypto, sockets or package dependency. Requires Workers WebCrypto + fetch.
 * No provider is enabled implicitly. Review the fixed allowlist before configuring
 * PUSH_ENABLED=true and PUSH_ALLOWED_PROVIDERS (comma-separated fcm,mozilla,apple).
 */
export interface PushSettings {
 VAPID_PUBLIC_KEY?: string; // base64url, uncompressed P-256 point, 65 bytes
 VAPID_PRIVATE_KEY?: string; // SECRET: base64url P-256 scalar, 32 bytes
 VAPID_SUBJECT?: string; // operator mailto: address or HTTPS contact URL
 PUSH_ENABLED?: string;
 PUSH_ALLOWED_PROVIDERS?: string;
}
export type PushEnv = Env & PushSettings;
export const MAX_PUSH_DEVICES = 5;
export type PushProvider = 'fcm'|'mozilla'|'apple';
export interface SubscriptionInput {endpoint:string;keys:{p256dh:string;auth:string}}
export interface PushSubscriptionRow {
 id:string;user_id:string;endpoint_unique_hash:string;endpoint_cipher:string;
 p256dh:string;auth:string;created_at:number;
}
export interface PushPayload {
 title:string;body:string;url?:string;notificationId?:string;
 /** Stable ID of the already committed notification/audited batch. Never a secret. */
 messageTopic:string;
}
export interface PushSummary {
 accepted:number;gone:number;failed:number;unknown:number;skipped:number;
 auditFailures:number;disabled:boolean;
}
export class PushError extends Error {
 constructor(public readonly code:'INVALID_PUSH'|'PUSH_CONFIG'|'PUSH_PAYLOAD'|'PUSH_CRYPTO') {super(code);this.name='PushError';}
}
const text = new TextEncoder();
const utf8 = new TextDecoder('utf-8',{fatal:true});
type Bytes = Uint8Array<ArrayBuffer>;
export function encodeBase64url(bytes:Uint8Array):string {
 let value='';for(const b of bytes)value+=String.fromCharCode(b);
 return btoa(value).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function decodeBase64url(value:string, expectedBytes?:number):Bytes {
 if(typeof value!=='string'||!value||value.length>8192||!/^[A-Za-z0-9_-]+$/.test(value)||value.length%4===1)throw new PushError('INVALID_PUSH');
 let decoded:Bytes;try{decoded=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}catch{throw new PushError('INVALID_PUSH');}
 if(encodeBase64url(decoded)!==value||(expectedBytes!==undefined&&decoded.length!==expectedBytes))throw new PushError('INVALID_PUSH');
 return decoded;
}
function join(...parts:Uint8Array[]):Bytes {
 const out=new Uint8Array(parts.reduce((sum,p)=>sum+p.length,0));let offset=0;
 for(const p of parts){out.set(p,offset);offset+=p.length;}return out;
}
/** Exact documented-provider host/path shapes only. No DNS resolution or external
 * calls in validation. No suffix matching, redirects, arbitrary host overrides,
 * IP literals, URL credentials, query/fragment, percent escapes or non-443 ports.
 * Known shapes must still be independently reviewed by the integrating parent.
 * Narrow host pinning + redirect:error prevents caller-controlled SSRF. DNS for
 * these trusted provider-owned names remains an infrastructure trust boundary.
 */
export function validatePushEndpoint(endpoint:string):{endpoint:string;provider:PushProvider;origin:string} {
 if(typeof endpoint!=='string'||endpoint.length>2400||!/^https:\/\/[\x21-\x7e]+$/.test(endpoint))throw new PushError('INVALID_PUSH');
 let url:URL;try{url=new URL(endpoint);}catch{throw new PushError('INVALID_PUSH');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.href!==endpoint)throw new PushError('INVALID_PUSH');
 const hosts:Record<string,{provider:PushProvider;path:RegExp}>={
  'fcm.googleapis.com':{provider:'fcm',path:/^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:-]{20,2048}$/},
  'updates.push.services.mozilla.com':{provider:'mozilla',path:/^\/wpush\/v[12]\/[A-Za-z0-9_-]{20,2048}$/},
  'web.push.apple.com':{provider:'apple',path:/^\/[A-Za-z0-9_-]{20,2048}$/}
 };
 const rule=Object.prototype.hasOwnProperty.call(hosts,url.hostname)?hosts[url.hostname]:undefined;
 if(!rule||!rule.path.test(url.pathname))throw new PushError('INVALID_PUSH');
 return{endpoint:url.href,provider:rule.provider,origin:url.origin};
}
export async function validateSubscription(input:SubscriptionInput):Promise<SubscriptionInput> {
 validatePushEndpoint(input.endpoint);
 const point=decodeBase64url(input.keys.p256dh,65);decodeBase64url(input.keys.auth,16);
 if(point[0]!==4)throw new PushError('INVALID_PUSH');
 try{await crypto.subtle.importKey('raw',point,{name:'ECDH',namedCurve:'P-256'},false,[]);}catch{throw new PushError('INVALID_PUSH');}
 return{endpoint:input.endpoint,keys:{p256dh:input.keys.p256dh,auth:input.keys.auth}};
}
function allowedProviders(env:PushEnv):Set<PushProvider> {
 const configured=env.PUSH_ALLOWED_PROVIDERS?.split(',').map(p=>p.trim()).filter(Boolean)??[];
 if(!configured.length||configured.some(p=>!['fcm','mozilla','apple'].includes(p)))throw new PushError('PUSH_CONFIG');
 return new Set(configured as PushProvider[]);
}
export function validateVapidPublicKey(value:string):string {
 try{const point=decodeBase64url(value,65);if(point[0]!==4)throw new PushError('PUSH_CONFIG');return value;}catch{throw new PushError('PUSH_CONFIG');}
}
export function pushConfigured(env:PushEnv):boolean {
 try{if(env.PUSH_ENABLED!=='true'||!env.SESSION_SECRET||env.SESSION_SECRET.length<32||!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY||!env.VAPID_SUBJECT)return false;
  validateVapidPublicKey(env.VAPID_PUBLIC_KEY);decodeBase64url(env.VAPID_PRIVATE_KEY,32);validateSubject(env.VAPID_SUBJECT);allowedProviders(env);return true;
 }catch{return false;}
}
export function requirePushConfiguration(env:PushEnv):void {if(!pushConfigured(env))throw new PushError('PUSH_CONFIG');}
export function requireAllowedEndpoint(env:PushEnv,endpoint:string):ReturnType<typeof validatePushEndpoint> {
 const value=validatePushEndpoint(endpoint);if(!allowedProviders(env).has(value.provider))throw new PushError('INVALID_PUSH');return value;
}
function validateSubject(subject:string):void {
 if(subject.length>300)throw new PushError('PUSH_CONFIG');
 if(/^mailto:[A-Za-z0-9.!#$&'*+\-/=?^_`{|}~]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(subject))return;
 try{const u=new URL(subject);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&!u.search&&u.href===subject)return;}catch{}
 throw new PushError('PUSH_CONFIG');
}
async function hkdf(ikm:Bytes,salt:Bytes,info:Bytes,length:number):Promise<Bytes> {
 const key=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);
 return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8));
}
async function storageMaterial(secret:string,purpose:string):Promise<Bytes> {
 if(typeof secret!=='string'||secret.length<32)throw new PushError('PUSH_CONFIG');
 return hkdf(text.encode(secret),text.encode('VIP push storage v1'),text.encode(purpose),32);
}
export async function endpointLookupHash(secret:string,endpoint:string):Promise<string> {
 validatePushEndpoint(endpoint);
 const key=await crypto.subtle.importKey('raw',await storageMaterial(secret,'endpoint-lookup'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return encodeBase64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,text.encode(endpoint))));
}
function aad(userId:string,hash:string,field:string):Bytes {return text.encode(JSON.stringify(['vip-push-v1',userId,hash,field]));}
export async function encryptPushValue(secret:string,value:string,userId:string,hash:string,field:string):Promise<string> {
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const key=await crypto.subtle.importKey('raw',await storageMaterial(secret,'subscription-at-rest'),'AES-GCM',false,['encrypt']);
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(userId,hash,field),tagLength:128},key,text.encode(value));
 return`v1.${encodeBase64url(iv)}.${encodeBase64url(new Uint8Array(cipher))}`;
}
export async function decryptPushValue(secret:string,cipher:string,userId:string,hash:string,field:string):Promise<string> {
 try{const parts=cipher.split('.');if(parts.length!==3||parts[0]!=='v1')throw new PushError('PUSH_CRYPTO');
  const iv=decodeBase64url(parts[1],12),bytes=decodeBase64url(parts[2]);if(bytes.length<16)throw new PushError('PUSH_CRYPTO');
  const key=await crypto.subtle.importKey('raw',await storageMaterial(secret,'subscription-at-rest'),'AES-GCM',false,['decrypt']);
  return utf8.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(userId,hash,field),tagLength:128},key,bytes));
 }catch{throw new PushError('PUSH_CRYPTO');}
}
export async function encryptSubscription(secret:string,userId:string,input:SubscriptionInput):Promise<Omit<PushSubscriptionRow,'id'|'created_at'>> {
 await validateSubscription(input);const hash=await endpointLookupHash(secret,input.endpoint);
 const [endpoint_cipher,p256dh,auth]=await Promise.all([
  encryptPushValue(secret,input.endpoint,userId,hash,'endpoint'),encryptPushValue(secret,input.keys.p256dh,userId,hash,'p256dh'),encryptPushValue(secret,input.keys.auth,userId,hash,'auth')]);
 return{user_id:userId,endpoint_unique_hash:hash,endpoint_cipher,p256dh,auth};
}
export async function decryptSubscription(secret:string,row:PushSubscriptionRow):Promise<SubscriptionInput> {
 const [endpoint,p256dh,auth]=await Promise.all([
  decryptPushValue(secret,row.endpoint_cipher,row.user_id,row.endpoint_unique_hash,'endpoint'),decryptPushValue(secret,row.p256dh,row.user_id,row.endpoint_unique_hash,'p256dh'),decryptPushValue(secret,row.auth,row.user_id,row.endpoint_unique_hash,'auth')]);
 const input=await validateSubscription({endpoint,keys:{p256dh,auth}});
 if(await endpointLookupHash(secret,endpoint)!==row.endpoint_unique_hash)throw new PushError('PUSH_CRYPTO');return input;
}
export function safePushURL(url='/account'):string {
 if(!/^\/(?:account|admin)(?:\?[A-Za-z0-9_=&%-]*)?$/.test(url))throw new PushError('PUSH_PAYLOAD');return url;
}
export function serializePushPayload(payload:PushPayload):Bytes {
 if(typeof payload.title!=='string'||!payload.title.trim()||payload.title.length>300||typeof payload.body!=='string'||payload.body.length>6000||!/^[-A-Za-z0-9_]{16,128}$/.test(payload.messageTopic)||
  (payload.notificationId!==undefined&&!/^[-A-Za-z0-9_]{16,80}$/.test(payload.notificationId)))throw new PushError('PUSH_PAYLOAD');
 // Push is a preview, not the canonical notification. Trim by code point until the
 // UTF-8 JSON fits a single <=4096-byte push body (86 header + 16 tag + delimiter).
 let body=Array.from(payload.body).slice(0,1200).join('');
 const title=Array.from(payload.title).slice(0,160).join('');
 let bytes:Bytes;
 do{bytes=text.encode(JSON.stringify({title,body,url:safePushURL(payload.url),...(payload.notificationId?{notificationId:payload.notificationId}:{})}));
  if(bytes.length<=3993)return bytes;body=Array.from(body).slice(0,-80).join('');
 }while(body.length);
 throw new PushError('PUSH_PAYLOAD');
}
export async function messageTopic(value:string):Promise<string> {
 if(!/^[-A-Za-z0-9_]{16,128}$/.test(value))throw new PushError('PUSH_PAYLOAD');
 return encodeBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256',text.encode('VIP push topic v1:'+value))).slice(0,24));
}
/** RFC8291 ECDH + auth HKDF; RFC8188 aes128gcm one final record (delimiter 0x02).
 * Salt and ephemeral ECDH key are newly generated for every preparation.
 */
export async function encryptWebPush(payload:Bytes,input:SubscriptionInput):Promise<Bytes> {
 if(payload.length>3993)throw new PushError('PUSH_PAYLOAD');await validateSubscription(input);
 const uaPublic=decodeBase64url(input.keys.p256dh,65),auth=decodeBase64url(input.keys.auth,16);
 const ua=await crypto.subtle.importKey('raw',uaPublic,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const as=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const asPublic=new Uint8Array(await crypto.subtle.exportKey('raw',as.publicKey));
 const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:ua},as.privateKey,256));
 const ikm=await hkdf(shared,auth,join(text.encode('WebPush: info\0'),uaPublic,asPublic),32);
 const salt=crypto.getRandomValues(new Uint8Array(16));
 const [cek,nonce]=await Promise.all([hkdf(ikm,salt,text.encode('Content-Encoding: aes128gcm\0'),16),hkdf(ikm,salt,text.encode('Content-Encoding: nonce\0'),12)]);
 const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
 const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,tagLength:128},key,join(payload,new Uint8Array([2]))));
 const header=new Uint8Array(86);header.set(salt);new DataView(header.buffer).setUint32(16,4096,false);header[20]=65;header.set(asPublic,21);
 return join(header,cipher);
}
export interface VapidKeys {publicKey:string;subject:string;signingKey:CryptoKey}
export async function importVapidKeys(publicKey:string,privateKey:string,subject:string):Promise<VapidKeys> {
 try{validateSubject(subject);const point=decodeBase64url(validateVapidPublicKey(publicKey),65),d=decodeBase64url(privateKey,32);
  const jwk={kty:'EC',crv:'P-256',x:encodeBase64url(point.slice(1,33)),y:encodeBase64url(point.slice(33)),d:encodeBase64url(d)};
  const signingKey=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const verifyingKey=await crypto.subtle.importKey('raw',point,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  const proof=text.encode('VIP VAPID key-pair validation');
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signingKey,proof);
  if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},verifyingKey,signature,proof))throw new PushError('PUSH_CONFIG');
  return{publicKey,subject,signingKey};
 }catch{throw new PushError('PUSH_CONFIG');}
}
export async function createVapidAuthorization(endpoint:string,keys:VapidKeys,time=now()):Promise<string> {
 const {origin}=validatePushEndpoint(endpoint);
 const header=encodeBase64url(text.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
 const claims=encodeBase64url(text.encode(JSON.stringify({aud:origin,exp:time+12*3600,sub:keys.subject})));
 const signingInput=`${header}.${claims}`;
 // WebCrypto ECDSA produces IEEE P1363 r||s, NOT ASN.1/DER. JWT needs 64 bytes.
 const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.signingKey,text.encode(signingInput)));
 if(signature.length!==64)throw new PushError('PUSH_CRYPTO');
 return`vapid t=${signingInput}.${encodeBase64url(signature)}, k=${keys.publicKey}`;
}
export function classifyPushResponse(status:number):'accepted'|'gone'|'failed'|'unknown' {
 // RFC8030 acceptance is 201 Created, not arbitrary 2xx. It is NOT delivery.
 if(status===201)return'accepted';if(status===404||status===410)return'gone';
 if(status>=400&&status<500)return'failed';return'unknown';
}
function snapshot(row:PushSubscriptionRow) {
 return{sql:"EXISTS(SELECT 1 FROM push_subscriptions p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.user_id=? AND p.endpoint_cipher=? AND p.p256dh=? AND p.auth=? AND u.status='active')",args:[row.id,row.user_id,row.endpoint_cipher,row.p256dh,row.auth]};
}
/** Call only AFTER committing notifications. Schedule using ExecutionContext.waitUntil;
 * never hold the notification transaction open for a provider response. No retries.
 * The stable topic + subscription ID is claimed once in append-only audit_events;
 * an unknown response or interrupted worker is never automatically resent.
 */
export async function sendPushForUsers(env:PushEnv,ids:readonly string[],payload:PushPayload):Promise<PushSummary> {
 const result:PushSummary={accepted:0,gone:0,failed:0,unknown:0,skipped:0,auditFailures:0,disabled:false};
 if(!pushConfigured(env)){result.disabled=true;return result;}
 let bytes:Bytes,topic:string,keys:VapidKeys;
 try{bytes=serializePushPayload(payload);topic=await messageTopic(payload.messageTopic);keys=await importVapidKeys(env.VAPID_PUBLIC_KEY!,env.VAPID_PRIVATE_KEY!,env.VAPID_SUBJECT!);}
 catch{result.failed++;try{await auditOnly(env,{actor:'system:push',action:'push.configuration',object:'push',outcome:'failed'});}catch{result.auditFailures++;}return result;}
 const users=[...new Set(ids)];if(users.length>5000||users.some(id=>!/^[-A-Za-z0-9_]{1,80}$/.test(id))){result.failed++;return result;}
 const rows:PushSubscriptionRow[]=[];
 try{for(let offset=0;offset<users.length;offset+=80){const chunk=users.slice(offset,offset+80);
  const found=await env.DB.prepare(`SELECT p.* FROM push_subscriptions p JOIN users u ON u.id=p.user_id WHERE u.status='active' AND p.user_id IN (${chunk.map(()=>'?').join(',')}) ORDER BY p.id`).bind(...chunk).all<PushSubscriptionRow>();rows.push(...found.results);
 }}catch{result.failed++;return result;}
 let cursor=0;
 const worker=async()=>{while(cursor<rows.length){const row=rows[cursor++],object=`push:${row.id}:topic:${topic}`;
  let endpoint:string,requestBody:Bytes,authorization:string;
  try{const input=await decryptSubscription(env.SESSION_SECRET,row);endpoint=requireAllowedEndpoint(env,input.endpoint).endpoint;
   [requestBody,authorization]=await Promise.all([encryptWebPush(bytes,input),createVapidAuthorization(endpoint,keys)]);
  }catch{result.failed++;try{await auditOnly(env,{actor:'system:push',action:'push.result',object,outcome:'preflight_failed'});}catch{result.auditFailures++;}continue;}
  try{const objectHash=await hmac(env,'audit-object:'+object);
   await auditedBatch(env,{actor:'system:push',action:'push.dispatch',object,outcome:'started'},
   {sql:`(${snapshot(row).sql}) AND NOT EXISTS(SELECT 1 FROM audit_events WHERE action='push.dispatch' AND object=?)`,args:[...snapshot(row).args,objectHash]},()=>[]);
  }catch(error){if(error instanceof HttpError&&error.code==='CONFLICT')result.skipped++;else{result.failed++;result.auditFailures++;}continue;}
  let outcome:'accepted'|'gone'|'failed'|'unknown'='unknown',status=0;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10_000);
  try{const response=await fetch(endpoint,{method:'POST',redirect:'error',credentials:'omit',signal:controller.signal,
   headers:{Authorization:authorization,'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:'3600',Urgency:'normal',Topic:topic},body:requestBody});
   status=response.status;outcome=classifyPushResponse(status);
   // Never read, log or persist provider bodies/Location headers (may echo secrets).
   if(response.body)try{await response.body.cancel();}catch{}
  }catch{outcome='unknown';}finally{clearTimeout(timer);}
  result[outcome]++;
  try{await auditedBatch(env,{actor:'system:push',action:'push.result',object,outcome:`${outcome}:${status||'network'}`},{sql:'1'},eventId=>{
   if(outcome!=='gone')return[];const g=gate(eventId);
   // CAS: never delete a subscription refreshed while this request was in flight.
   return[env.DB.prepare(`DELETE FROM push_subscriptions WHERE id=? AND user_id=? AND endpoint_cipher=? AND p256dh=? AND auth=? AND ${g.sql}`).bind(row.id,row.user_id,row.endpoint_cipher,row.p256dh,row.auth,...g.args)];
  });}catch{result.auditFailures++;}
 }};
 await Promise.all(Array.from({length:Math.min(3,rows.length)},worker));return result;
}
