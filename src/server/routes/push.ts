import {Hono} from 'hono';
import {z} from 'zod';
import {type AppEnv,type Ctx,authenticated,body,fail,now,randomToken,platformRequest,requestLimit,rateLimit} from '../security';
import {auditedBatch,gate} from '../services/audit';
import {type PushEnv,MAX_PUSH_DEVICES,PushError,pushConfigured,requirePushConfiguration,requireAllowedEndpoint,
 validateVapidPublicKey,validateSubscription,validatePushEndpoint,encryptSubscription,endpointLookupHash,importVapidKeys,decodeBase64url} from '../services/push';

const locale=z.enum(['ar','en']).optional();
const subscriptionSchema=z.object({endpoint:z.string().min(1).max(2400),keys:z.object({p256dh:z.string().max(100),auth:z.string().max(30)}).strict(),locale}).strict();
const deleteSchema=z.object({endpoint:z.string().min(1).max(2400).optional(),subscriptionId:z.string().regex(/^[-A-Za-z0-9_]{24,80}$/).optional(),all:z.literal(true).optional(),locale}).strict()
 .refine(d=>Number(d.endpoint!==undefined)+Number(d.subscriptionId!==undefined)+Number(d.all===true)===1);
function activeSession(c:Ctx) {
 return{sql:"EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.status='active' AND s.token_hash=? AND s.expires_at>?)",args:[c.get('user')!.id,c.get('session')!.token_hash,now()]};
}
function rejectPushError(error:unknown):never {
 if(error instanceof PushError)fail(error.code==='PUSH_CONFIG'?'SERVICE_UNAVAILABLE':'INVALID_INPUT',error.code==='PUSH_CONFIG'?503:400);
 throw error;
}
export const pushRoutes=new Hono<AppEnv>();
/** Public key ONLY. Never return env, private scalar, subject, endpoints or auth keys. */
pushRoutes.get('/key',async c=>{
 if(!platformRequest(c))fail('ORIGIN',403);
 const env:PushEnv=c.env;
 try{requirePushConfiguration(env);const publicKey=validateVapidPublicKey(env.VAPID_PUBLIC_KEY!);
  // Reject syntactically valid but off-curve public points before advertising them.
  try{await crypto.subtle.importKey('raw',decodeBase64url(publicKey,65),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}catch{fail('SERVICE_UNAVAILABLE',503);}
  return c.json({publicKey});
 }catch(error){rejectPushError(error);}
});
pushRoutes.get('/status',authenticated,async c=>{
 const rows=await c.env.DB.prepare('SELECT id,created_at FROM push_subscriptions WHERE user_id=? ORDER BY created_at,id').bind(c.get('user')!.id).all<{id:string;created_at:number}>();
 return c.json({enabled:pushConfigured(c.env),deviceCount:rows.results.length,maxDevices:MAX_PUSH_DEVICES,
  subscriptions:rows.results.map(row=>({id:row.id,createdAt:new Date(row.created_at*1000).toISOString()}))});
});
pushRoutes.post('/subscription',authenticated,async c=>{
 await requestLimit(c,'push-subscription',30,60);await rateLimit(c.env,'push-user:'+c.get('user')!.id,20,60);
 const data=await body(c,subscriptionSchema),env:PushEnv=c.env,userId=c.get('user')!.id;
 let sealed:Awaited<ReturnType<typeof encryptSubscription>>;
 try{requirePushConfiguration(env);requireAllowedEndpoint(env,data.endpoint);await validateSubscription(data);
  await importVapidKeys(env.VAPID_PUBLIC_KEY!,env.VAPID_PRIVATE_KEY!,env.VAPID_SUBJECT!);
  sealed=await encryptSubscription(env.SESSION_SECRET,userId,data);
 }catch(error){rejectPushError(error);}
 const previous=await env.DB.prepare('SELECT id,user_id FROM push_subscriptions WHERE endpoint_unique_hash=?').bind(sealed.endpoint_unique_hash).first<{id:string;user_id:string}>();
 // Do not let an endpoint supplied by one account overwrite another account.
 if(previous&&previous.user_id!==userId)fail('CONFLICT',409);
 const count=(await env.DB.prepare('SELECT count(*) AS count FROM push_subscriptions WHERE user_id=?').bind(userId).first<{count:number}>())?.count??0;
 if(!previous&&count>=MAX_PUSH_DEVICES)return c.json({code:'PUSH_DEVICE_LIMIT',error:c.get('locale')==='en'?'Five devices are already registered. Remove a device first.':'سُجلت خمسة أجهزة بالفعل. ألغِ أحدها أولاً.'},429);
 const id=previous?.id??randomToken(24),session=activeSession(c);
 const identity=previous?{sql:'EXISTS(SELECT 1 FROM push_subscriptions WHERE id=? AND user_id=? AND endpoint_unique_hash=?)',args:[id,userId,sealed.endpoint_unique_hash]}:
  {sql:'NOT EXISTS(SELECT 1 FROM push_subscriptions WHERE endpoint_unique_hash=?)',args:[sealed.endpoint_unique_hash]};
 await auditedBatch(env,{actor:userId,action:previous?'push.subscription.refresh':'push.subscription.create',object:id},
  {sql:`(${session.sql}) AND (${identity.sql}) AND NOT EXISTS(SELECT 1 FROM push_subscriptions WHERE endpoint_unique_hash=? AND user_id<>?) AND ((SELECT count(*) FROM push_subscriptions WHERE user_id=?)<5 OR EXISTS(SELECT 1 FROM push_subscriptions WHERE endpoint_unique_hash=? AND user_id=?))`,
   args:[...session.args,...identity.args,sealed.endpoint_unique_hash,userId,userId,sealed.endpoint_unique_hash,userId]},eventId=>{
   const g=gate(eventId);return[env.DB.prepare(`INSERT INTO push_subscriptions(id,user_id,endpoint_unique_hash,endpoint_cipher,p256dh,auth,created_at) SELECT ?,?,?,?,?,?,? WHERE ${g.sql} ON CONFLICT(endpoint_unique_hash) DO UPDATE SET endpoint_cipher=excluded.endpoint_cipher,p256dh=excluded.p256dh,auth=excluded.auth WHERE push_subscriptions.user_id=excluded.user_id`)
    .bind(id,userId,sealed.endpoint_unique_hash,sealed.endpoint_cipher,sealed.p256dh,sealed.auth,now(),...g.args)];
  });
 // A competing insertion/deletion returns 409, not a phantom audited identity.
 const saved=await env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint_unique_hash=? AND user_id=?').bind(sealed.endpoint_unique_hash,userId).first<{id:string}>();
 if(!saved)fail('CONFLICT',409);return c.json({ok:true,subscriptionId:saved.id,registered:true},previous?200:201);
});
pushRoutes.delete('/subscription',authenticated,async c=>{
 await requestLimit(c,'push-unsubscribe',30,60);const data=await body(c,deleteSchema),userId=c.get('user')!.id;
 let where='user_id=?';const args:unknown[]=[userId];
 if(data.endpoint!==undefined){let hash:string;try{validatePushEndpoint(data.endpoint);hash=await endpointLookupHash(c.env.SESSION_SECRET,data.endpoint);}catch(error){rejectPushError(error);}
  where+=' AND endpoint_unique_hash=?';args.push(hash);
 }else if(data.subscriptionId){where+=' AND id=?';args.push(data.subscriptionId);}
 // Cancellation remains available while PUSH_ENABLED is false. Idempotent and
 // user-scoped; cancelling somebody else's ID reveals nothing about its existence.
 await auditedBatch(c.env,{actor:userId,action:'push.subscription.delete',object:data.all?'push-all:'+userId:data.subscriptionId??'push-endpoint:'+await endpointLookupHash(c.env.SESSION_SECRET,data.endpoint!)},activeSession(c),eventId=>{
  const g=gate(eventId);return[c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE ${where} AND ${g.sql}`).bind(...args,...g.args)];
 });return c.json({ok:true,registered:false});
});
