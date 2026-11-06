import {Hono} from 'hono';
import {z} from 'zod';
import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse,type RegistrationResponseJSON,type AuthenticationResponseJSON,type AuthenticatorTransportFuture} from '@simplewebauthn/server';
import {BRAND} from '../../shared/types';
import {type AppEnv,type UserRow,type Ctx,body,fail,now,randomToken,authenticated,stepUp,requireOrigin,requestLimit,fromBase64,bytesToBase64,createSession} from '../security';
import {auditedBatch,gate,and} from '../services/audit';
import {sessionResult} from './auth';
interface ChallengeRow{id:string;user_id:string|null;kind:string;challenge:string;origin:string;rp_id:string;session_hash:string|null;expires_at:number;consumed_at:number|null;}
interface PasskeyRow{id:string;user_id:string;public_key:string;counter:number;transports:string;}
const locale=z.enum(['ar','en']).optional(),credentialId=z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);
const responseBase={id:credentialId,rawId:credentialId,type:z.literal('public-key'),clientExtensionResults:z.record(z.unknown()),authenticatorAttachment:z.enum(['platform','cross-platform']).optional()};
const registrationSchema=z.object({...responseBase,response:z.object({clientDataJSON:credentialId,attestationObject:z.string().min(1).max(100000).regex(/^[A-Za-z0-9_-]+$/),transports:z.array(z.enum(['ble','cable','hybrid','internal','nfc','smart-card','usb'])).optional(),publicKeyAlgorithm:z.number().optional(),publicKey:z.string().optional(),authenticatorData:z.string().optional()}).passthrough()}).passthrough();
const authenticationSchema=z.object({...responseBase,response:z.object({clientDataJSON:credentialId,authenticatorData:credentialId,signature:credentialId,userHandle:z.string().max(512).optional()}).passthrough()}).passthrough();
export function relyingParty(c:Ctx){requireOrigin(c);const origin=c.req.header('Origin')!,host=new URL(origin).hostname;const rpID=c.env.RP_ID??(c.env.COOKIE_MODE==='production'?BRAND.domain:host);if(!(host===rpID||host.endsWith('.'+rpID))||rpID.includes(':')||rpID.includes('/')||(c.env.COOKIE_MODE==='production'&&rpID!==BRAND.domain))fail('SERVICE_UNAVAILABLE',503);return{origin,rpID};}
export const passkeyRoutes=new Hono<AppEnv>();
passkeyRoutes.post('/register/options',authenticated,async c=>{
 stepUp(c);await requestLimit(c,'passkey-register',10,600);await body(c,z.object({locale}).strict());const user=c.get('user')!,{origin,rpID}=relyingParty(c),time=now();
 const rows=await c.env.DB.prepare('SELECT id,transports FROM passkeys WHERE user_id=?').bind(user.id).all<PasskeyRow>();if(rows.results.length>=10)fail('RATE_LIMIT',429);
 const options=await generateRegistrationOptions({rpName:'VIP',rpID,userName:user.email,userDisplayName:user.name,userID:new TextEncoder().encode(user.id),attestationType:'none',supportedAlgorithmIDs:[-7,-257],authenticatorSelection:{residentKey:'required',userVerification:'required'},excludeCredentials:rows.results.map(r=>({id:r.id,transports:JSON.parse(r.transports) as AuthenticatorTransportFuture[]})),timeout:300000});
 const id=randomToken(24);await c.env.DB.prepare("INSERT INTO webauthn_challenges(id,user_id,kind,challenge,origin,rp_id,session_hash,created_at,expires_at) VALUES(?,?,'register',?,?,?,?,?,?)").bind(id,user.id,options.challenge,origin,rpID,c.get('session')!.token_hash,time,time+300).run();return c.json({challengeId:id,options});
});
passkeyRoutes.post('/register/verify',authenticated,async c=>{
 stepUp(c);const data=await body(c,z.object({challengeId:z.string().max(80),response:registrationSchema,locale}).strict()),user=c.get('user')!,time=now();
 const challenge=await c.env.DB.prepare("SELECT * FROM webauthn_challenges WHERE id=? AND user_id=? AND kind='register' AND session_hash=? AND consumed_at IS NULL AND expires_at>?").bind(data.challengeId,user.id,c.get('session')!.token_hash,time).first<ChallengeRow>();if(!challenge||challenge.origin!==c.req.header('Origin'))fail('PASSKEY_INVALID');
 let result;try{result=await verifyRegistrationResponse({response:data.response as RegistrationResponseJSON,expectedChallenge:challenge.challenge,expectedOrigin:challenge.origin,expectedRPID:challenge.rp_id,requireUserVerification:true});}catch{fail('PASSKEY_INVALID');}
 if(!result.verified||!result.registrationInfo)fail('PASSKEY_INVALID');const info=result.registrationInfo,credential=info.credential;
 await auditedBatch(c.env,{actor:user.id,action:'auth.passkey_register',object:user.id},{sql:"EXISTS(SELECT 1 FROM webauthn_challenges WHERE id=? AND consumed_at IS NULL AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM passkeys WHERE id=?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')",args:[challenge.id,time,credential.id,user.id]},eventId=>{const g=gate(eventId);return[c.env.DB.prepare(`UPDATE webauthn_challenges SET consumed_at=? WHERE id=? AND ${g.sql}`).bind(time,challenge.id,...g.args??[]),c.env.DB.prepare(`INSERT INTO passkeys(id,user_id,public_key,counter,transports,device_type,backed_up,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${g.sql}`).bind(credential.id,user.id,bytesToBase64(credential.publicKey),credential.counter,JSON.stringify(credential.transports??[]),info.credentialDeviceType,info.credentialBackedUp?1:0,time,...g.args??[])];});return c.json({verified:true});
});
passkeyRoutes.post('/authentication/options',async c=>{
 const{origin,rpID}=relyingParty(c);await requestLimit(c,'passkey-options',30,600);const data=await body(c,z.object({email:z.string().trim().toLowerCase().email().optional(),locale}).strict());let user:UserRow|null=null;
 if(data.email){user=await c.env.DB.prepare("SELECT * FROM users WHERE email=? AND status='active'").bind(data.email).first<UserRow>();if(!user)fail('PASSKEY_INVALID');}
 const rows=user?await c.env.DB.prepare('SELECT * FROM passkeys WHERE user_id=?').bind(user.id).all<PasskeyRow>():null;if(rows&&!rows.results.length)fail('PASSKEY_INVALID');
 const options=await generateAuthenticationOptions({rpID,timeout:300000,userVerification:'required',...(rows?{allowCredentials:rows.results.map(r=>({id:r.id,transports:JSON.parse(r.transports) as AuthenticatorTransportFuture[]}))}:{})});
 const id=randomToken(24),time=now();await c.env.DB.prepare("INSERT INTO webauthn_challenges(id,user_id,kind,challenge,origin,rp_id,created_at,expires_at) VALUES(?,?,'authenticate',?,?,?,?,?)").bind(id,user?.id??null,options.challenge,origin,rpID,time,time+300).run();return c.json({challengeId:id,options});
});
passkeyRoutes.post('/authentication/verify',async c=>{
 requireOrigin(c);await requestLimit(c,'passkey-verify',30,600);const data=await body(c,z.object({challengeId:z.string().max(80),response:authenticationSchema,locale}).strict()),time=now();
 const challenge=await c.env.DB.prepare("SELECT * FROM webauthn_challenges WHERE id=? AND kind='authenticate' AND consumed_at IS NULL AND expires_at>?").bind(data.challengeId,time).first<ChallengeRow>();if(!challenge||challenge.origin!==c.req.header('Origin'))fail('PASSKEY_INVALID');
 const credential=await c.env.DB.prepare('SELECT * FROM passkeys WHERE id=?').bind(data.response.id).first<PasskeyRow>();if(!credential||challenge.user_id&&credential.user_id!==challenge.user_id)fail('PASSKEY_INVALID');
 const user=await c.env.DB.prepare("SELECT * FROM users WHERE id=? AND status='active'").bind(credential.user_id).first<UserRow>();if(!user)fail('PASSKEY_INVALID');
 if(data.response.response.userHandle&&new TextDecoder().decode(fromBase64(data.response.response.userHandle))!==user.id)fail('PASSKEY_INVALID');
 let result;try{result=await verifyAuthenticationResponse({response:data.response as AuthenticationResponseJSON,expectedChallenge:challenge.challenge,expectedOrigin:challenge.origin,expectedRPID:challenge.rp_id,requireUserVerification:true,credential:{id:credential.id,publicKey:fromBase64(credential.public_key),counter:credential.counter,transports:JSON.parse(credential.transports) as AuthenticatorTransportFuture[]}});}catch{fail('PASSKEY_INVALID');}
 if(!result.verified)fail('PASSKEY_INVALID');
 await auditedBatch(c.env,{actor:user.id,action:'auth.passkey_login',object:user.id},and({sql:"EXISTS(SELECT 1 FROM webauthn_challenges WHERE id=? AND consumed_at IS NULL AND expires_at>?)",args:[challenge.id,time]},{sql:"EXISTS(SELECT 1 FROM passkeys p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.counter=? AND u.status='active')",args:[credential.id,credential.counter]}),eventId=>{const g=gate(eventId);return[c.env.DB.prepare(`UPDATE webauthn_challenges SET consumed_at=? WHERE id=? AND ${g.sql}`).bind(time,challenge.id,...g.args??[]),c.env.DB.prepare(`UPDATE passkeys SET counter=? WHERE id=? AND ${g.sql}`).bind(result.authenticationInfo.newCounter,credential.id,...g.args??[])];});const csrf=await createSession(c,user);return c.json(await sessionResult(c,user,csrf));
});
