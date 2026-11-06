import {Hono} from 'hono';
import {z} from 'zod';
import {BRAND,EMPTY_PROFILE,type ProfileData,type Role} from '../../shared/types';
import {type AppEnv,type UserRow,body,fail,now,randomToken,randomPIN,hmac,constantTime,validSlug,requireOrigin,requireSecret,requestLimit,rateLimit,createSession,publicUser,authenticated,stepUp,hashPassword,verifyPassword,clearSessionCookie,localized,localeFor} from '../security';
import {ownSite,toSite} from '../services/profiles';
import {auditedBatch,and,gate,auditOnly,type Predicate} from '../services/audit';
import {enqueueEmail,deliverEmail,otpEmail,pruneExpired} from '../services/email';
import {passkeyRoutes} from './passkeys';
import {isReservedName,unreservedNameSQL} from '../services/reserves';
export interface Challenge {id:string;email:string;purpose:'signup'|'login'|'recover';pin_hash:string;payload_json:string;attempts:number;expires_at:number;created_at:number;consumed_at:number|null;delivery_state:string;}
export interface Invitation {id:string;email:string;role:Exclude<Role,'owner'>;mode:'moderator'|'managed'|'handover';site_id:string|null;expected_owner_id:string|null;payload_json:string;expires_at:number;accepted_at:number|null;invited_by:string;}
const email=z.string().trim().toLowerCase().email().max(254),locale=z.enum(['ar','en']).optional();
const requestSchema=z.object({email,purpose:z.enum(['signup','login','recover']),name:z.string().trim().min(1).max(240).optional(),slug:z.string().trim().toLowerCase().max(63).optional(),language:z.enum(['ar','en']).optional(),locale,whatsapp:z.string().max(32).regex(/^[+\d ()-]*$/).optional(),phone:z.string().max(32).regex(/^[+\d ()-]*$/).optional(),termsAccepted:z.boolean().optional(),ageConfirmed:z.boolean().optional(),challengeId:z.string().max(80).optional(),inviteId:z.string().max(80).optional()}).strict();
interface Payload {name?:string;slug?:string;language?:'ar'|'en';locale?:'ar'|'en';whatsapp?:string;phone?:string;inviteId?:string;}
export function verifiedRole(emailAddress:string):Role{return emailAddress===BRAND.owners[0]?'owner':emailAddress===BRAND.owners[1]?'principal':'user';}
export async function sessionResult(c:Parameters<typeof createSession>[0],user:UserRow,csrf:string){const site=await ownSite(c.env,user.id);const passkey=await c.env.DB.prepare('SELECT id FROM passkeys WHERE user_id=? LIMIT 1').bind(user.id).first();return{user:publicUser(user,!!passkey),csrf,site:site?toSite(site):null};}
export const authRoutes=new Hono<AppEnv>();
authRoutes.post('/request',async c=>{
 requireOrigin(c);requireSecret(c.env);await requestLimit(c,'otp-request',15,600);const data=await body(c,requestSchema);const time=now();
 if(data.challengeId){const ch=await c.env.DB.prepare('SELECT * FROM otp_challenges WHERE id=? AND email=? AND purpose=? AND consumed_at IS NULL AND expires_at>?').bind(data.challengeId,data.email,data.purpose,time).first<Challenge>();if(!ch)fail('OTP_INVALID');const result=await deliverEmail(c.env,ch.id);if(!result.accepted)fail(result.unknown?'EMAIL_UNKNOWN':'EMAIL_UNAVAILABLE',503);return c.json({challengeId:ch.id,message:localeFor(c)==='en'?'Verification email accepted for sending.':'قُبلت رسالة التحقق للإرسال.',expiresIn:ch.expires_at-time,resendAfter:60});}
 if(!c.env.RESEND_API_KEY&&!c.env.EMAIL)fail('EMAIL_UNAVAILABLE',503);
 await rateLimit(c.env,'otp-email:'+data.email,8,3600);
 const recent=await c.env.DB.prepare('SELECT created_at FROM otp_challenges WHERE email=? ORDER BY created_at DESC LIMIT 1').bind(data.email).first<{created_at:number}>();if(recent&&recent.created_at>time-60)fail('RATE_LIMIT',429);
 const user=await c.env.DB.prepare("SELECT * FROM users WHERE email=? AND status='active'").bind(data.email).first<UserRow>();
 let invitation:Invitation|null=null;
 if(data.inviteId){invitation=await c.env.DB.prepare('SELECT * FROM invitations WHERE id=? AND email=? AND accepted_at IS NULL AND expires_at>?').bind(data.inviteId,data.email,time).first<Invitation>();if(!invitation)fail('INVITATION');}
 if(data.purpose==='signup'&&user&&!invitation)fail('CONFLICT',409);
 if(data.purpose!=='signup'&&!user&&!invitation&&verifiedRole(data.email)==='user')fail('OTP_INVALID');
 const payload:Payload={name:data.name,slug:data.slug,language:data.language,locale:data.locale??localeFor(c),whatsapp:data.whatsapp??'',phone:data.phone??'',inviteId:data.inviteId};
 if(!user&&invitation&&(data.termsAccepted!==true||data.ageConfirmed!==true))fail('INVALID_INPUT');
 if(invitation?.mode==='managed'){const configured=JSON.parse(invitation.payload_json) as Payload;payload.name=configured.name??data.name;payload.slug=configured.slug;payload.language=configured.language;}
 const createSite=(!user&&data.purpose==='signup'&&!invitation)||invitation?.mode==='managed';
 if(createSite&&user&&await ownSite(c.env,user.id))fail('CONFLICT',409);
 if(createSite){if(!payload.name||!payload.slug||!payload.language||data.termsAccepted!==true||data.ageConfirmed!==true)fail('INVALID_INPUT');if(await isReservedName(c.env,payload.slug))fail('SLUG_UNAVAILABLE',409);}
 const resendLock=await c.env.DB.prepare('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start WHERE rate_limits.window_start<=? RETURNING window_start').bind(await hmac(c.env,'otp-resend:'+data.email),time,time-60).first();if(!resendLock)fail('RATE_LIMIT',429);
 const id=randomToken(24),pin=randomPIN(),pinHash=await hmac(c.env,`otp:${id}:${pin}`);
 const statements:D1PreparedStatement[]=[];
 if(createSite){const p=unreservedNameSQL(payload.slug!);statements.push(c.env.DB.prepare(`INSERT INTO slug_reservations(slug,email,challenge_id,expires_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM sites WHERE slug=?) AND ${p.sql} ON CONFLICT(slug) DO UPDATE SET email=excluded.email,challenge_id=excluded.challenge_id,expires_at=excluded.expires_at WHERE (slug_reservations.expires_at<=? OR slug_reservations.email=excluded.email) AND ${p.sql}`).bind(payload.slug,data.email,id,time+600,payload.slug,...p.args??[],time,...p.args??[]));}
 statements.push(c.env.DB.prepare('UPDATE otp_challenges SET consumed_at=? WHERE email=? AND consumed_at IS NULL AND (?=0 OR EXISTS(SELECT 1 FROM slug_reservations WHERE challenge_id=?))').bind(time,data.email,createSite?1:0,id));
 statements.push(c.env.DB.prepare("INSERT INTO otp_challenges(id,email,purpose,pin_hash,payload_json,expires_at,created_at) SELECT ?,?,?,?,?,?,? WHERE (?=0 OR EXISTS(SELECT 1 FROM slug_reservations WHERE challenge_id=?))").bind(id,data.email,data.purpose,pinHash,JSON.stringify(payload),time+600,time,createSite?1:0,id));
 const results=await c.env.DB.batch(statements);if(results[results.length-1].meta.changes!==1)fail('SLUG_UNAVAILABLE',409);
 try{await enqueueEmail(c.env,id,otpEmail(data.email,pin,payload.locale??'ar',payload.name,!!invitation),time+600);}catch{await c.env.DB.prepare("UPDATE otp_challenges SET delivery_state='failed' WHERE id=?").bind(id).run();fail('EMAIL_UNAVAILABLE',503);}
 const result=await deliverEmail(c.env,id);
 if(!result.accepted)return c.json({error:localized(result.unknown?'EMAIL_UNKNOWN':'EMAIL_UNAVAILABLE',localeFor(c)),code:result.unknown?'EMAIL_UNKNOWN':'EMAIL_UNAVAILABLE',challengeId:id},503);
 // Finite request-driven cleanup; no scheduled infrastructure.
 if(Math.random()<0.02)await pruneExpired(c.env);
 return c.json({challengeId:id,message:localeFor(c)==='en'?'Verification email accepted for sending.':'قُبلت رسالة التحقق للإرسال.',expiresIn:600,resendAfter:60});
});
authRoutes.post('/verify',async c=>{
 requireOrigin(c);await requestLimit(c,'otp-verify',40,600);
 const data=await body(c,z.object({challengeId:z.string().min(20).max(80),pin:z.string().regex(/^\d{6}$/),acceptInvitation:z.boolean().optional(),locale}).strict());const time=now();
 const challenge=await c.env.DB.prepare("UPDATE otp_challenges SET attempts=attempts+1 WHERE id=? AND attempts<6 AND consumed_at IS NULL AND expires_at>? AND delivery_state IN ('accepted','unknown') RETURNING *").bind(data.challengeId,time).first<Challenge>();
 if(!challenge||!constantTime(challenge.pin_hash,await hmac(c.env,`otp:${challenge.id}:${data.pin}`)))fail('OTP_INVALID');
 const payload=JSON.parse(challenge.payload_json) as Payload;
 let user=await c.env.DB.prepare("SELECT * FROM users WHERE email=? AND status='active'").bind(challenge.email).first<UserRow>();
 let invitation:Invitation|null=null;
 if(payload.inviteId){if(!data.acceptInvitation)fail('INVITATION');invitation=await c.env.DB.prepare('SELECT * FROM invitations WHERE id=? AND email=? AND accepted_at IS NULL AND expires_at>?').bind(payload.inviteId,challenge.email,time).first<Invitation>();if(!invitation)fail('INVITATION');}
 const newUser=!user,userId=user?.id??randomToken(24),siteId=randomToken(24),fixedRole=verifiedRole(challenge.email),assignedRole=fixedRole!=='user'?fixedRole:invitation?.mode==='moderator'?invitation.role:user?.role??'user';
 const shouldCreateSite=!!payload.slug&&(newUser||invitation?.mode==='managed')&&invitation?.mode!=='handover';
 const base={sql:"EXISTS(SELECT 1 FROM otp_challenges WHERE id=? AND consumed_at IS NULL AND expires_at>? AND attempts<=6)",args:[challenge.id,time]};
 const predicates:Predicate[]=[base,{sql:newUser?'NOT EXISTS(SELECT 1 FROM users WHERE email=?)':"EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')",args:[newUser?challenge.email:userId]}];
 if(shouldCreateSite){if(!validSlug(payload.slug!))fail('SLUG_UNAVAILABLE',409);predicates.push(unreservedNameSQL(payload.slug!),{sql:'EXISTS(SELECT 1 FROM slug_reservations WHERE slug=? AND challenge_id=? AND email=? AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM sites WHERE slug=? OR owner_id=?)',args:[payload.slug,challenge.id,challenge.email,time,payload.slug,userId]});}
 if(invitation){predicates.push({sql:"EXISTS(SELECT 1 FROM invitations i JOIN users actor ON actor.id=i.invited_by WHERE i.id=? AND i.accepted_at IS NULL AND i.expires_at>? AND actor.status='active' AND actor.role IN ('owner','principal'))",args:[invitation.id,time]});if(invitation.mode==='handover')predicates.push({sql:'EXISTS(SELECT 1 FROM sites WHERE id=? AND owner_id=?) AND NOT EXISTS(SELECT 1 FROM sites WHERE owner_id=?)',args:[invitation.site_id,invitation.expected_owner_id,userId]});}
 const profile:ProfileData={...structuredClone(EMPTY_PROFILE),name:payload.name??user?.name??challenge.email.split('@')[0],email:challenge.email,whatsapp:payload.whatsapp??'',phone:payload.phone??''};
 await auditedBatch(c.env,{actor:userId,action:invitation?'invitation.accept':newUser?'auth.register':'auth.verify',object:invitation?.site_id??userId},and(...predicates),eventId=>{
 const g=gate(eventId);const stmts=[c.env.DB.prepare(`UPDATE otp_challenges SET consumed_at=?,verified_user_id=? WHERE id=? AND ${g.sql}`).bind(time,userId,challenge.id,...g.args??[])];
 if(newUser){stmts.push(c.env.DB.prepare(`UPDATE counters SET value=value+1 WHERE name='public_id' AND ${g.sql}`).bind(...g.args??[]));stmts.push(c.env.DB.prepare(`INSERT INTO users(id,email,name,role,public_id,locale,verified_at,created_at) SELECT ?,?,?,?,value,?,?,? FROM counters WHERE name='public_id' AND ${g.sql}`).bind(userId,challenge.email,profile.name,assignedRole,payload.locale??'ar',time,time,...g.args??[]));}
 else stmts.push(c.env.DB.prepare(`UPDATE users SET role=?,verified_at=? WHERE id=? AND ${g.sql}`).bind(assignedRole,time,userId,...g.args??[]));
 if(shouldCreateSite)stmts.push(c.env.DB.prepare(`INSERT INTO sites(id,owner_id,slug,language,draft_json,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE ${g.sql}`).bind(siteId,userId,payload.slug,payload.language,JSON.stringify(profile),time,time,...g.args??[]));
 if(invitation){stmts.push(c.env.DB.prepare(`UPDATE invitations SET accepted_at=?,accepted_by=? WHERE id=? AND ${g.sql}`).bind(time,userId,invitation.id,...g.args??[]));if(invitation.mode==='handover'){stmts.push(c.env.DB.prepare(`UPDATE reviews SET status='changes',decided_at=?,decided_by=?,note='ownership_transfer',decision_event=? WHERE site_id=? AND status='pending' AND ${g.sql}`).bind(time,userId,eventId,invitation.site_id,...g.args??[]));stmts.push(c.env.DB.prepare(`UPDATE sites SET owner_id=?,pending_review=NULL,revision=revision+1,updated_at=? WHERE id=? AND ${g.sql}`).bind(userId,time,invitation.site_id,...g.args??[]));stmts.push(c.env.DB.prepare(`UPDATE media SET user_id=? WHERE user_id=? AND ${g.sql}`).bind(userId,invitation.expected_owner_id,...g.args??[]));
 stmts.push(c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND ${g.sql}`).bind(invitation.expected_owner_id,...g.args??[]));}}
 if(challenge.purpose==='recover')stmts.push(c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND ${g.sql}`).bind(userId,...g.args??[]));
 stmts.push(c.env.DB.prepare(`DELETE FROM slug_reservations WHERE challenge_id=? AND ${g.sql}`).bind(challenge.id,...g.args??[]));return stmts;
 });
 user=await c.env.DB.prepare("SELECT * FROM users WHERE id=? AND status='active'").bind(userId).first<UserRow>();if(!user)fail('UNAUTHORIZED',401);const csrf=await createSession(c,user);return c.json(await sessionResult(c,user,csrf));
});
authRoutes.post('/login',async c=>{
 requireOrigin(c);await requestLimit(c,'password-login',20,600);const data=await body(c,z.object({email,password:z.string().max(256),locale}).strict());await rateLimit(c.env,'login:'+data.email,12,600);
 const user=await c.env.DB.prepare("SELECT * FROM users WHERE email=? AND status='active'").bind(data.email).first<UserRow>();
 const dummy='pbkdf2-sha256$v1$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
 const good=await verifyPassword(c.env,data.password,user?.password_hash??dummy);if(!user||!user.password_hash||!good)fail('OTP_INVALID',401);
 const csrf=await createSession(c,user);await auditOnly(c.env,{actor:user.id,action:'auth.password_login',object:user.id});return c.json(await sessionResult(c,user,csrf));
});
authRoutes.post('/password',authenticated,async c=>{
 stepUp(c);const data=await body(c,z.object({password:z.string().max(256),locale}).strict()),user=c.get('user')!,session=c.get('session')!,hash=await hashPassword(c.env,data.password),time=now();
 await auditedBatch(c.env,{actor:user.id,action:'auth.password_set',object:user.id},{sql:"EXISTS(SELECT 1 FROM users WHERE id=? AND status='active') AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND auth_at>?)",args:[user.id,session.token_hash,time-300]},eventId=>{const g=gate(eventId);return[c.env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=? AND ${g.sql}`).bind(hash,user.id,...g.args??[]),c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash<>? AND ${g.sql}`).bind(user.id,session.token_hash,...g.args??[])];});
 const updated=await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first<UserRow>();return c.json({ok:true,user:publicUser(updated??user,!!await c.env.DB.prepare('SELECT id FROM passkeys WHERE user_id=? LIMIT 1').bind(user.id).first())});
});
authRoutes.post('/logout',authenticated,async c=>{await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(c.get('session')!.token_hash).run();clearSessionCookie(c);return c.json({ok:true});});
authRoutes.get('/invitations/:id',async c=>{const invite=await c.env.DB.prepare('SELECT mode,expires_at FROM invitations WHERE id=? AND accepted_at IS NULL AND expires_at>?').bind(c.req.param('id'),now()).first<{mode:string;expires_at:number}>();if(!invite)fail('NOT_FOUND',404);return c.json({invitation:{id:c.req.param('id'),mode:invite.mode,expiresAt:invite.expires_at}});});
authRoutes.route('/passkeys',passkeyRoutes);
authRoutes.route('/passkey',passkeyRoutes);
