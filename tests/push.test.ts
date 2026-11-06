import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createPrivateKey,createPublicKey,diffieHellman,hkdfSync,createDecipheriv,verify as nodeVerify} from 'node:crypto';
import {Hono} from 'hono';
import {pushRoutes} from '../src/server/routes/push';
import {type AppEnv,initialize,HttpError,localized,localeFor,now,randomToken,sha256} from '../src/server/security';
import {type PushEnv,type PushSubscriptionRow,type SubscriptionInput,encodeBase64url,decodeBase64url,
 validatePushEndpoint,validateSubscription,endpointLookupHash,encryptPushValue,decryptPushValue,
 encryptSubscription,decryptSubscription,serializePushPayload,safePushURL,messageTopic,encryptWebPush,
 importVapidKeys,createVapidAuthorization,classifyPushResponse,pushConfigured,requireAllowedEndpoint,sendPushForUsers} from '../src/server/services/push';

// Tests mutate ONLY disposable :memory: SQLite and generated ephemeral keys.
// No existing project file/database is written. Every fetch is blocked or mocked.
const encoder=new TextEncoder(),secret='push-test-only-secret-at-least-thirty-two-characters';
const token='A'.repeat(80),endpoint='https://fcm.googleapis.com/fcm/send/'+token;
const topic='notification-test-topic-123456';
async function clientKeys(){
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const publicBytes=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
 return{pair,input:{endpoint,keys:{p256dh:encodeBase64url(publicBytes),auth:encodeBase64url(crypto.getRandomValues(new Uint8Array(16)))}}};
}
async function vapid(){
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const publicKey=encodeBase64url(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));
 const privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
 return{pair,publicKey,privateKey:privateJwk.d!,subject:'mailto:operator@example.com'};
}
function payload(){return{title:'VIP اختبار',body:'رسالة داخل التطبيق — In-app message',url:'/account',messageTopic:topic};}

class Statement {
 constructor(readonly db:DatabaseSync,readonly sql:string,readonly values:unknown[]=[]){ }
 bind(...values:unknown[]){return new Statement(this.db,this.sql,values);}
 async first<T>():Promise<T|null>{return(this.db.prepare(this.sql).get(...this.values as (string|number|null)[])??null) as T|null;}
 async all<T>(){return{success:true,results:this.db.prepare(this.sql).all(...this.values as (string|number|null)[]) as T[],meta:{changes:0}};}
 async run(){return this.execute();}
 execute(){const result=this.db.prepare(this.sql).run(...this.values as (string|number|null)[]);return{success:true,results:[],meta:{changes:Number(result.changes)}};}
}
class MemoryD1 {
 readonly db=new DatabaseSync(':memory:');
 constructor(){for(const file of ['0001.sql','0002-admin-content.sql','0003-push.sql'])this.db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));}
 prepare(sql:string){return new Statement(this.db,sql);}
 async batch(statements:Statement[]){this.db.exec('BEGIN IMMEDIATE');try{const rows=statements.map(s=>s.execute());this.db.exec('COMMIT');return rows;}catch(error){this.db.exec('ROLLBACK');throw error;}}
}
let database:MemoryD1,env:PushEnv,app:Hono<AppEnv>,calls:ReturnType<typeof vi.fn>;
beforeEach(async()=>{
 calls=vi.fn(async()=>{throw new Error('NETWORK_FORBIDDEN');});vi.stubGlobal('fetch',calls);
 database=new MemoryD1();const keys=await vapid();env={DB:database as unknown as D1Database,SESSION_SECRET:secret,PUBLIC_ORIGIN:'https://idvip.app',COOKIE_MODE:'production',
  PUSH_ENABLED:'true',PUSH_ALLOWED_PROVIDERS:'fcm,mozilla,apple',VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:keys.subject};
 app=new Hono<AppEnv>();app.use('*',initialize);app.onError((error,c)=>{const known=error instanceof HttpError;return c.json({error:localized(known?error.code:'SERVICE_UNAVAILABLE',localeFor(c)),code:known?error.code:'SERVICE_UNAVAILABLE'},known?error.status:503);});app.route('/push',pushRoutes);
});
afterEach(()=>{database.db.close();vi.unstubAllGlobals();});
async function account(index=1){
 const id='user-'+index,token=randomToken(),csrf=randomToken(),time=now();
 database.db.prepare('INSERT INTO users(id,email,name,role,public_id,verified_at,created_at) VALUES(?,?,?,?,?,?,?)').run(id,`user${index}@example.com`,'User','user',index,time,time);
 database.db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,created_at,expires_at,auth_at) VALUES(?,?,?,?,?,?)').run(await sha256(token),id,csrf,time,time+86400,time);return{id,token,csrf};
}
async function request(path:string,method='GET',json?:unknown,user?:Awaited<ReturnType<typeof account>>,extra:Record<string,string>={}){
 return app.request('https://idvip.app'+path,{method,headers:{...(method!=='GET'?{Origin:'https://idvip.app','Content-Type':'application/json'}:{}),...(user?{Cookie:`__Host-vip_session=${user.token}`,'X-CSRF-Token':user.csrf}:{}),...extra},...(json?{body:JSON.stringify(json)}:{})},env);
}
async function seed(userId:string,input:SubscriptionInput){
 const sealed=await encryptSubscription(secret,userId,input),id=randomToken(24),time=now();
 database.db.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint_unique_hash,endpoint_cipher,p256dh,auth,created_at) VALUES(?,?,?,?,?,?,?)').run(id,userId,sealed.endpoint_unique_hash,sealed.endpoint_cipher,sealed.p256dh,sealed.auth,time);
 return{id,created_at:time,...sealed} satisfies PushSubscriptionRow;
}

describe('pure endpoint and key validation',()=>{
 it('accepts only canonical pinned provider host/path shapes',()=>{
  expect(validatePushEndpoint(endpoint).provider).toBe('fcm');
  expect(validatePushEndpoint('https://fcm.googleapis.com/wp/'+token).provider).toBe('fcm');
  expect(validatePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/'+token).provider).toBe('mozilla');
  expect(validatePushEndpoint('https://web.push.apple.com/'+token).provider).toBe('apple');expect(calls).not.toHaveBeenCalled();
 });
 it('rejects SSRF, credential tricks, private IPs, alternate numeric IPs and host suffix tricks',()=>{
  for(const bad of ['http://fcm.googleapis.com/fcm/send/'+token,'https://127.0.0.1/'+token,'https://[::1]/'+token,'https://10.0.0.1/'+token,'https://169.254.169.254/'+token,
   'https://2130706433/'+token,'https://0177.0.0.1/'+token,'https://localhost/'+token,'https://fcm.googleapis.com.evil.test/fcm/send/'+token,
   'https://evil.fcm.googleapis.com/fcm/send/'+token,'https://fcm.googleapis.com@127.0.0.1/'+token,'https://u:p@fcm.googleapis.com/fcm/send/'+token,
   'https://fcm.googleapis.com:8443/fcm/send/'+token,'https://fcm.googleapis.com:443/fcm/send/'+token,'https://FCM.GOOGLEAPIS.COM/fcm/send/'+token,
   endpoint+'?x=y',endpoint+'#fragment',endpoint+'/',endpoint+'%2f',endpoint+'\n','https://fcm.googleapis.com/other/'+token])expect(()=>validatePushEndpoint(bad),bad).toThrow();
  expect(calls).not.toHaveBeenCalled();
 });
 it('uses canonical unpadded base64url and exact key lengths',()=>{
  const bytes=crypto.getRandomValues(new Uint8Array(32));expect(decodeBase64url(encodeBase64url(bytes),32)).toEqual(bytes);
  for(const bad of ['A','AB','AA=','AA+','AA/','AA\n',''])expect(()=>decodeBase64url(bad)).toThrow();
  expect(()=>decodeBase64url('AA',16)).toThrow();
 });
 it('requires an uncompressed on-curve P256 key and exactly 16 auth bytes',async()=>{
  const {input}=await clientKeys();expect(await validateSubscription(input)).toEqual(input);
  await expect(validateSubscription({...input,keys:{...input.keys,auth:'AA'}})).rejects.toThrow();
  const bad=new Uint8Array(65);bad[0]=4;
  await expect(validateSubscription({...input,keys:{...input.keys,p256dh:encodeBase64url(bad)}})).rejects.toThrow();
 });
 it('is disabled until explicitly enabled and providers are selected',()=>{
  expect(pushConfigured(env)).toBe(true);expect(pushConfigured({...env,PUSH_ENABLED:undefined})).toBe(false);
  expect(pushConfigured({...env,PUSH_ALLOWED_PROVIDERS:undefined})).toBe(false);expect(pushConfigured({...env,PUSH_ALLOWED_PROVIDERS:'fcm,arbitrary'})).toBe(false);
  expect(()=>requireAllowedEndpoint({...env,PUSH_ALLOWED_PROVIDERS:'apple'},endpoint)).toThrow();
 });
});

describe('pure at-rest encryption helpers',()=>{
 it('uses a stable secret-keyed endpoint lookup hash with domain separation',async()=>{
  const hash=await endpointLookupHash(secret,endpoint);expect(hash).toHaveLength(43);expect(await endpointLookupHash(secret,endpoint)).toBe(hash);
  expect(await endpointLookupHash('different-test-secret-12345678901234567890',endpoint)).not.toBe(hash);
  const plain=encodeBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(endpoint))));expect(hash).not.toBe(plain);
 });
 it('uses fresh 96-bit IVs and authenticated encryption, without storing endpoint or keys raw',async()=>{
  const {input}=await clientKeys(),first=await encryptSubscription(secret,'user-1',input),second=await encryptSubscription(secret,'user-1',input);
  expect(first.endpoint_cipher).not.toBe(second.endpoint_cipher);expect(first.p256dh).not.toBe(input.keys.p256dh);expect(first.auth).not.toBe(input.keys.auth);
  expect(JSON.stringify(first)).not.toContain(endpoint);expect(decodeBase64url(first.endpoint_cipher.split('.')[1])).toHaveLength(12);
  expect(await decryptSubscription(secret,{id:'x',created_at:1,...first})).toEqual(input);
 });
 it('authenticates the owner, endpoint hash, field, version, ciphertext and storage secret',async()=>{
  const hash=await endpointLookupHash(secret,endpoint),cipher=await encryptPushValue(secret,endpoint,'user-1',hash,'endpoint');
  for(const [s,u,h,f] of [[secret,'user-2',hash,'endpoint'],[secret,'user-1','wrong-hash','endpoint'],[secret,'user-1',hash,'auth'],['different-secret-12345678901234567890','user-1',hash,'endpoint']])
   await expect(decryptPushValue(s,cipher,u,h,f)).rejects.toThrow('PUSH_CRYPTO');
  const parts=cipher.split('.'),bytes=decodeBase64url(parts[2]);bytes[0]^=1;
  await expect(decryptPushValue(secret,parts.slice(0,2).join('.')+'.'+encodeBase64url(bytes),'user-1',hash,'endpoint')).rejects.toThrow('PUSH_CRYPTO');
  await expect(decryptPushValue(secret,cipher.replace('v1.','v2.'),'user-1',hash,'endpoint')).rejects.toThrow('PUSH_CRYPTO');
 });
});

describe('pure RFC8291/RFC8188 and VAPID helpers',()=>{
 it('decrypts the native WebCrypto result using independent Node ECDH/HKDF/AES-GCM primitives',async()=>{
  const {pair,input}=await clientKeys(),plain=serializePushPayload(payload()),body=await encryptWebPush(plain,input);
  expect(body.length).toBeLessThanOrEqual(4096);expect(new DataView(body.buffer).getUint32(16,false)).toBe(4096);expect(body[20]).toBe(65);
  const senderPoint=body.slice(21,86),jwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
  const sender=createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:encodeBase64url(senderPoint.slice(1,33)),y:encodeBase64url(senderPoint.slice(33))}});
  const shared=diffieHellman({privateKey:createPrivateKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:jwk.x!,y:jwk.y!,d:jwk.d!}}),publicKey:sender});
  const info=Buffer.concat([Buffer.from('WebPush: info\0'),Buffer.from(decodeBase64url(input.keys.p256dh)),Buffer.from(senderPoint)]);
  const ikm=Buffer.from(hkdfSync('sha256',shared,Buffer.from(decodeBase64url(input.keys.auth)),info,32));
  const cek=Buffer.from(hkdfSync('sha256',ikm,Buffer.from(body.slice(0,16)),Buffer.from('Content-Encoding: aes128gcm\0'),16));
  const nonce=Buffer.from(hkdfSync('sha256',ikm,Buffer.from(body.slice(0,16)),Buffer.from('Content-Encoding: nonce\0'),12));
  const decipher=createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(Buffer.from(body.slice(-16)));
  const clear=Buffer.concat([decipher.update(body.slice(86,-16)),decipher.final()]);expect(clear.at(-1)).toBe(2);expect(new Uint8Array(clear.subarray(0,-1))).toEqual(plain);
 });
 it('generates fresh ephemeral keys and salt for every message',async()=>{
  const {input}=await clientKeys(),plain=serializePushPayload(payload()),a=await encryptWebPush(plain,input),b=await encryptWebPush(plain,input);
  expect(a.slice(0,16)).not.toEqual(b.slice(0,16));expect(a.slice(21,86)).not.toEqual(b.slice(21,86));
 });
 it('caps the complete UTF8 push body without corrupting Arabic or emoji; full text stays in notifications',async()=>{
  const long={...payload(),body:'إشعار مهم 🔔 '.repeat(300)},before=long.body,plain=serializePushPayload(long),parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
  expect(plain.length).toBeLessThanOrEqual(3993);expect(parsed.body.length).toBeLessThan(long.body.length);expect(long.body).toBe(before);
  expect(parsed).not.toHaveProperty('messageTopic');expect(parsed.body).not.toContain('\uFFFD');
  const {input}=await clientKeys();expect((await encryptWebPush(plain,input)).length).toBeLessThanOrEqual(4096);
  await expect(encryptWebPush(new Uint8Array(3994),input)).rejects.toThrow('PUSH_PAYLOAD');
 });
 it('allows only internal account/admin click paths and stable bounded topic tokens',async()=>{
  expect(safePushURL()).toBe('/account');expect(safePushURL('/account?tab=notifications')).toBe('/account?tab=notifications');
  for(const bad of ['https://evil.test','//evil.test','/\\evil.test','/site/user','/account/../evil','/account#bad'])expect(()=>safePushURL(bad)).toThrow();
  const a=await messageTopic(topic);expect(a).toHaveLength(32);expect(a).toMatch(/^[A-Za-z0-9_-]+$/);expect(await messageTopic(topic)).toBe(a);
  expect(await messageTopic(topic+'2')).not.toBe(a);await expect(messageTopic('short')).rejects.toThrow();
 });
 it('signs ES256 JWT using raw r||s with audience equal to the endpoint origin and <=24h expiry',async()=>{
  const fixture=await vapid(),keys=await importVapidKeys(fixture.publicKey,fixture.privateKey,fixture.subject),time=1_800_000_000;
  const auth=await createVapidAuthorization(endpoint,keys,time);expect(auth.endsWith(', k='+fixture.publicKey)).toBe(true);
  const jwt=auth.slice('vapid t='.length).split(', k=')[0],parts=jwt.split('.');
  const claims=JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1])));expect(claims).toEqual({aud:'https://fcm.googleapis.com',exp:time+12*3600,sub:fixture.subject});
  const signature=decodeBase64url(parts[2]);expect(signature.length).toBe(64);
  const jwk=await crypto.subtle.exportKey('jwk',fixture.pair.publicKey);
  expect(nodeVerify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key:createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:jwk.x!,y:jwk.y!}}),dsaEncoding:'ieee-p1363'},Buffer.from(signature))).toBe(true);
 });
 it('rejects mismatched private/public VAPID keys and invalid contact subjects',async()=>{
  const a=await vapid(),b=await vapid();await expect(importVapidKeys(a.publicKey,b.privateKey,a.subject)).rejects.toThrow('PUSH_CONFIG');
  await expect(importVapidKeys(a.publicKey,a.privateKey,'javascript:bad')).rejects.toThrow('PUSH_CONFIG');
 });
 it('accepts only RFC8030 201; expires 404/410; never treats unknown HTTP or network responses as accepted',()=>{
  expect(classifyPushResponse(201)).toBe('accepted');for(const status of [404,410])expect(classifyPushResponse(status)).toBe('gone');
  for(const status of [400,401,403,413,429])expect(classifyPushResponse(status)).toBe('failed');for(const status of [0,200,202,204,301,500,503])expect(classifyPushResponse(status)).toBe('unknown');
 });
});

describe('in-memory routes and SQL security (no network)',()=>{
 it('exposes only the VAPID public key and requires authentication for status and mutation',async()=>{
  const response=await request('/push/key');expect(response.status).toBe(200);expect(await response.json()).toEqual({publicKey:env.VAPID_PUBLIC_KEY});
  expect((await request('/push/status')).status).toBe(401);expect((await request('/push/subscription','POST',(await clientKeys()).input)).status).toBe(401);expect(calls).not.toHaveBeenCalled();
 });
 it('enforces Origin + CSRF for POST and DELETE; tenant requests cannot receive a key',async()=>{
  const user=await account(),{input}=await clientKeys();
  expect((await request('/push/subscription','POST',input,user,{'X-CSRF-Token':''})).status).toBe(403);
  expect((await request('/push/subscription','POST',input,user,{Origin:'https://tenant.idvip.app'})).status).toBe(403);
  expect((await request('/push/subscription','DELETE',{all:true},user,{Origin:'null'})).status).toBe(403);
  expect((await app.request('https://tenant.idvip.app/push/key',{},env)).status).toBe(403);expect(calls).not.toHaveBeenCalled();
 });
 it('saves ciphertext only and confirms actual server registration; refreshing at the cap is allowed',async()=>{
  const user=await account(),{input}=await clientKeys();
  for(let i=0;i<5;i++)expect((await request('/push/subscription','POST',{...input,endpoint:endpoint+String(i)},user)).status).toBe(201);
  expect((await request('/push/subscription','POST',{...input,endpoint:endpoint+'6'},user)).status).toBe(429);
  expect((await request('/push/subscription','POST',{...input,endpoint:endpoint+'0'},user)).status).toBe(200);
  const status=await request('/push/status','GET',undefined,user).then(r=>r.json()) as {deviceCount:number;subscriptions:unknown[]};expect(status.deviceCount).toBe(5);expect(status.subscriptions).toHaveLength(5);
  const dump=JSON.stringify(database.db.prepare('SELECT * FROM push_subscriptions').all());expect(dump).not.toContain('https:');expect(dump).not.toContain(input.keys.auth);expect(dump).not.toContain(input.keys.p256dh);
  expect(calls).not.toHaveBeenCalled();
 });
 it('prevents cross-account reassignment and provides idempotent user-scoped cancellation while disabled',async()=>{
  const alice=await account(),bob=await account(2),{input}=await clientKeys();const saved=await request('/push/subscription','POST',input,alice).then(r=>r.json()) as {subscriptionId:string};
  expect((await request('/push/subscription','POST',input,bob)).status).toBe(409);
  expect((await request('/push/subscription','DELETE',{subscriptionId:saved.subscriptionId},bob)).status).toBe(200);
  expect(database.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()?.n).toBe(1);
  env.PUSH_ENABLED='false';expect((await request('/push/subscription','DELETE',{endpoint},alice)).status).toBe(200);
  expect((await request('/push/subscription','DELETE',{endpoint},alice)).status).toBe(200);expect(database.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()?.n).toBe(0);
 });
 it('enforces five devices in SQLite and cascades deletion; audit is append-only and has no endpoint/auth secrets',async()=>{
  const user=await account(),{input}=await clientKeys();for(let i=0;i<5;i++)await seed(user.id,{...input,endpoint:endpoint+String(i)});
  const sixth=await encryptSubscription(secret,user.id,{...input,endpoint:endpoint+'sixth'});
  expect(()=>database.db.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint_unique_hash,endpoint_cipher,p256dh,auth,created_at) VALUES(?,?,?,?,?,?,?)').run(randomToken(24),user.id,sixth.endpoint_unique_hash,sixth.endpoint_cipher,sixth.p256dh,sixth.auth,now())).toThrow('push_device_limit');
  expect(()=>database.db.exec("UPDATE push_subscriptions SET user_id='different'" )).toThrow('immutable_push_identity');
  await request('/push/subscription','DELETE',{all:true},user);
  const dump=JSON.stringify(database.db.prepare('SELECT * FROM audit_events').all());expect(dump).not.toContain(endpoint);expect(dump).not.toContain(input.keys.auth);expect(dump).not.toContain(input.keys.p256dh);
  expect(()=>database.db.exec('DELETE FROM audit_events')).toThrow('append_only_audit');expect(()=>database.db.exec("UPDATE audit_events SET outcome='edited'")).toThrow('append_only_audit');
  await seed(user.id,input);database.db.prepare('DELETE FROM users WHERE id=?').run(user.id);expect(database.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()?.n).toBe(0);
 });
 it('rejects malicious subscription data and unreviewed providers without sending anything',async()=>{
  const user=await account(),{input}=await clientKeys();env.PUSH_ALLOWED_PROVIDERS='mozilla';
  expect((await request('/push/subscription','POST',input,user)).status).toBe(400);
  expect((await request('/push/subscription','POST',{...input,endpoint:'https://127.0.0.1/'+token},user)).status).toBe(400);
  expect((await request('/push/subscription','POST',{...input,user_id:'forged'},user)).status).toBe(400);expect(calls).not.toHaveBeenCalled();
 });
});

describe('mocked sender: no provider calls escape the test',()=>{
 it('does not fetch while disabled or for a provider excluded by the reviewed configuration',async()=>{
  const user=await account(),{input}=await clientKeys();await seed(user.id,input);env.PUSH_ENABLED='false';expect((await sendPushForUsers(env,[user.id],payload())).disabled).toBe(true);expect(calls).not.toHaveBeenCalled();
  env.PUSH_ENABLED='true';env.PUSH_ALLOWED_PROVIDERS='apple';expect((await sendPushForUsers(env,[user.id],payload())).failed).toBe(1);expect(calls).not.toHaveBeenCalled();
 });
 it('uses native ciphertext/VAPID, bounds in-flight work at three, and never resends the same dispatch topic',async()=>{
  const {input}=await clientKeys(),ids:string[]=[];for(let i=1;i<=2;i++){const user=await account(i);ids.push(user.id);for(let j=0;j<4;j++)await seed(user.id,{...input,endpoint:endpoint+String(i)+String(j)});}
  let inflight=0,max=0;calls.mockImplementation(async(_url:string,options:RequestInit)=>{inflight++;max=Math.max(max,inflight);expect(options.redirect).toBe('error');expect(options.credentials).toBe('omit');
   const headers=options.headers as Record<string,string>;expect(headers['Content-Encoding']).toBe('aes128gcm');expect(headers.Authorization).toMatch(/^vapid t=/);expect(headers.Topic.length).toBe(32);
   expect((options.body as Uint8Array).length).toBeLessThanOrEqual(4096);await new Promise(resolve=>setTimeout(resolve,10));inflight--;return new Response(null,{status:201});});
  const result=await sendPushForUsers(env,ids,payload());expect(result.accepted).toBe(8);expect(max).toBe(3);expect(result.auditFailures).toBe(0);
  const again=await sendPushForUsers(env,ids,payload());expect(again.skipped).toBe(8);expect(calls).toHaveBeenCalledTimes(8);
 });
 it('removes expired 410 subscriptions atomically with audit but retains failed/unknown subscriptions and app notifications',async()=>{
  const user=await account(),{input}=await clientKeys();for(let i=0;i<3;i++)await seed(user.id,{...input,endpoint:endpoint+String(i)});
  database.db.prepare('INSERT INTO notifications(id,user_id,title,body,created_at) VALUES(?,?,?,?,?)').run('notification',user.id,'Full title','Full body',now());
  calls.mockImplementation(async(url:string)=>new Response(null,{status:url.endsWith('0')?410:url.endsWith('1')?429:503}));
  const result=await sendPushForUsers(env,[user.id],payload());expect(result.gone).toBe(1);expect(result.failed).toBe(1);expect(result.unknown).toBe(1);expect(result.accepted).toBe(0);
  expect(database.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()?.n).toBe(2);expect(database.db.prepare('SELECT count(*) AS n FROM notifications').get()?.n).toBe(1);
  expect(database.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='push.result'").get()?.n).toBe(3);
 });
 it('never calls an ambiguous network response accepted, retries it or logs provider secrets',async()=>{
  const user=await account(),{input}=await clientKeys();await seed(user.id,input);calls.mockRejectedValue(new Error('secret endpoint '+endpoint+' auth '+input.keys.auth));
  const result=await sendPushForUsers(env,[user.id],payload());expect(result.unknown).toBe(1);expect(result.accepted).toBe(0);
  expect((await sendPushForUsers(env,[user.id],payload())).skipped).toBe(1);expect(calls).toHaveBeenCalledOnce();
  const dump=JSON.stringify(database.db.prepare('SELECT * FROM audit_events').all());expect(dump).not.toContain(endpoint);expect(dump).not.toContain(input.keys.auth);
 });
 it('CAS protects a subscription refreshed during an expired response',async()=>{
  const user=await account(),{input}=await clientKeys(),row=await seed(user.id,input);
  calls.mockImplementation(async()=>{const sealed=await encryptSubscription(secret,user.id,input);database.db.prepare('UPDATE push_subscriptions SET endpoint_cipher=?,p256dh=?,auth=? WHERE id=?').run(sealed.endpoint_cipher,sealed.p256dh,sealed.auth,row.id);return new Response(null,{status:410});});
  expect((await sendPushForUsers(env,[user.id],payload())).gone).toBe(1);expect(database.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()?.n).toBe(1);
 });
});
