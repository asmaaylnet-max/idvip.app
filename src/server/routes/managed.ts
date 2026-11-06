import {Hono} from 'hono';
import {z} from 'zod';
import {BRAND,EMPTY_PROFILE,type ProfileData,type PublicProfile} from '../../shared/types';
import {type AppEnv,type Ctx,type UserRow,authenticated,root,body,fail,now,requestLimit} from '../security';
import {auditedBatch,and,gate,rootSQL,auditOnly,type Predicate} from '../services/audit';
import {custodySQL,isCustodian,inviteManaged} from '../services/custody';
import {ownSite,toSite,profileSchema,referencedMedia,validateMediaOwnership} from '../services/profiles';
import {isReservedName,unreservedNameSQL} from '../services/reserves';
import {inspectWebP,MAX_IMAGE_BYTES} from './media';

export const managedRoutes=new Hono<AppEnv>();
managedRoutes.use('*',authenticated,root);
const locale=z.enum(['ar','en']).optional();
export const managedCreateSchema=z.object({email:z.string().trim().toLowerCase().email().max(254).refine(v=>!BRAND.owners.includes(v)),name:z.string().trim().min(1).max(240),slug:z.string().trim().toLowerCase().min(1).max(63),language:z.enum(['ar','en']),locale}).strict();
async function target(c:Ctx){
 const userId=c.req.param('id');if(!userId)fail('NOT_FOUND',404);
 if(!await isCustodian(c.env,c.get('user')!.id,userId))fail('NOT_FOUND',404);
 const user=await c.env.DB.prepare("SELECT * FROM users WHERE id=? AND status='active' AND COALESCE(verified_at,0)=0").bind(userId).first<UserRow>();
 const site=await ownSite(c.env,userId);if(!user||!site)fail('NOT_FOUND',404);return {user,site};
}
function mediaPredicate(userId:string,data:ProfileData):Predicate {
 const ids=referencedMedia(data);
 return ids.length?{sql:`(SELECT count(*) FROM media WHERE user_id=? AND id IN (${ids.map(()=>'?').join(',')}))=?`,args:[userId,...ids,ids.length]}:{sql:'1'};
}
managedRoutes.get('/',async c=>{
 const actor=c.get('user')!,p={sql:"EXISTS(SELECT 1 FROM users WHERE id=? AND role IN ('owner','principal') AND status='active')",args:[actor.id]};
 const rows=await c.env.DB.prepare(`SELECT u.id,u.email,u.name,u.public_id,s.id AS site_id,s.slug,s.language,s.status,s.revision,s.pending_review,c.created_at FROM custody c JOIN users u ON u.id=c.user_id JOIN sites s ON s.owner_id=u.id WHERE c.admin_id=? AND u.status='active' AND COALESCE(u.verified_at,0)=0 AND ${p.sql} ORDER BY c.created_at DESC,u.public_id DESC`).bind(actor.id,...p.args).all<{id:string;email:string;name:string;public_id:number;site_id:string;slug:string;language:string;status:string;revision:number;pending_review:string|null;created_at:number}>();
 return c.json({createdFiles:rows.results.map(r=>({id:r.id,email:r.email,name:r.name,publicId:r.public_id,siteId:r.site_id,slug:r.slug,language:r.language,status:r.status,revision:r.revision,pendingReview:r.pending_review,createdAt:new Date(r.created_at*1000).toISOString()}))});
});
managedRoutes.post('/',async c=>{
 await requestLimit(c,'managed-create',12,600);const input=await body(c,managedCreateSchema),actor=c.get('user')!,time=now();
 if(await isReservedName(c.env,input.slug))fail('SLUG_UNAVAILABLE',409);
 const userId=crypto.randomUUID(),siteId=crypto.randomUUID(),data:ProfileData={...structuredClone(EMPTY_PROFILE),name:input.name,email:input.email};
 const p=and(rootSQL(actor),unreservedNameSQL(input.slug),{sql:'NOT EXISTS(SELECT 1 FROM users WHERE email=?) AND NOT EXISTS(SELECT 1 FROM sites WHERE slug=?) AND NOT EXISTS(SELECT 1 FROM slug_reservations WHERE slug=? AND expires_at>?)',args:[input.email,input.slug,input.slug,time]});
 await auditedBatch(c.env,{actor:actor.id,action:'managed.create',object:userId},p,eventId=>{
  const g=gate(eventId),r=rootSQL(actor),cs=custodySQL(actor.id,userId);
  return [
   c.env.DB.prepare(`UPDATE counters SET value=value+1 WHERE name='public_id' AND ${r.sql} AND ${g.sql}`).bind(...r.args??[],...g.args),
   c.env.DB.prepare(`INSERT INTO users(id,email,name,role,public_id,locale,verified_at,created_at) SELECT ?,?,?,'user',value,?,0,? FROM counters WHERE name='public_id' AND ${r.sql} AND ${g.sql}`).bind(userId,input.email,input.name,input.locale??input.language,time,...r.args??[],...g.args),
   c.env.DB.prepare(`INSERT INTO custody(user_id,admin_id,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND role='user' AND COALESCE(verified_at,0)=0) AND ${r.sql} AND ${g.sql}`).bind(userId,actor.id,time,userId,...r.args??[],...g.args),
   c.env.DB.prepare(`INSERT INTO sites(id,owner_id,slug,language,draft_json,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE ${cs.sql} AND ${g.sql}`).bind(siteId,userId,input.slug,input.language,JSON.stringify(data),time,time,...cs.args??[],...g.args)
  ];
 });
 return c.json({id:userId,site:toSite((await ownSite(c.env,userId))!),invitationQueued:false},201);
});
managedRoutes.get('/:id',async c=>{const {user,site}=await target(c);return c.json({managedUser:{id:user.id,name:user.name,email:user.email,publicId:user.public_id},site:toSite(site)});});
managedRoutes.get('/:id/preview',async c=>{
 const {user,site}=await target(c),profile:PublicProfile={slug:site.slug,language:site.language,data:profileSchema.parse(JSON.parse(site.draft_json)),publicId:user.public_id};
 c.header('Cache-Control','private, no-store');return c.json({profile,revision:site.revision,private:true});
});
managedRoutes.put('/:id/draft',async c=>{
 await requestLimit(c,'managed-save',60,60);const input=await body(c,z.object({data:profileSchema,revision:z.number().int().min(0),language:z.enum(['ar','en']).optional(),locale}).strict()),{user,site}=await target(c),actor=c.get('user')!;
 if(input.revision!==site.revision)fail('CONFLICT',409);await validateMediaOwnership(c.env,user.id,input.data);
 const live=custodySQL(actor.id,user.id),cas={sql:'EXISTS(SELECT 1 FROM sites WHERE id=? AND owner_id=? AND revision=?)',args:[site.id,user.id,input.revision]},p=and(live,cas,mediaPredicate(user.id,input.data));
 await auditedBatch(c.env,{actor:actor.id,action:'managed.draft_save',object:site.id},p,eventId=>{const g=gate(eventId);return [c.env.DB.prepare(`UPDATE sites SET draft_json=?,language=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND ${live.sql} AND ${g.sql}`).bind(JSON.stringify(input.data),input.language??site.language,now(),site.id,user.id,input.revision,...live.args??[],...g.args)];});
 return c.json({site:toSite((await ownSite(c.env,user.id))!)});
});
managedRoutes.post('/:id/submit',async c=>{
 await requestLimit(c,'managed-submit',8,600);const input=await body(c,z.object({revision:z.number().int().min(0),locale}).strict()),{user,site}=await target(c),actor=c.get('user')!,id=crypto.randomUUID(),time=now();
 if(input.revision!==site.revision)fail('CONFLICT',409);const data=profileSchema.parse(JSON.parse(site.draft_json));await validateMediaOwnership(c.env,user.id,data);
 const live=custodySQL(actor.id,user.id),p=and(live,mediaPredicate(user.id,data),{sql:"EXISTS(SELECT 1 FROM sites WHERE id=? AND owner_id=? AND revision=? AND pending_review IS NULL) AND NOT EXISTS(SELECT 1 FROM reviews WHERE site_id=? AND status='pending')",args:[site.id,user.id,input.revision,site.id]});
 await auditedBatch(c.env,{actor:actor.id,action:'managed.submit',object:site.id},p,eventId=>{const g=gate(eventId);return [
  c.env.DB.prepare(`INSERT INTO reviews(id,site_id,owner_id,revision,kind,data_json,privacy_json,disclosure_revision,created_at) SELECT ?,id,owner_id,revision,CASE WHEN published_json IS NULL THEN 'publish' ELSE 'edit' END,draft_json,privacy_hidden,disclosure_revision,? FROM sites WHERE id=? AND revision=? AND ${live.sql} AND ${g.sql}`).bind(id,time,site.id,input.revision,...live.args??[],...g.args),
  c.env.DB.prepare(`UPDATE sites SET pending_review=?,status=CASE WHEN published_json IS NULL THEN 'review' ELSE status END,updated_at=? WHERE id=? AND revision=? AND ${live.sql} AND ${g.sql}`).bind(id,time,site.id,input.revision,...live.args??[],...g.args)
 ];});return c.json({reviewId:id,site:toSite((await ownSite(c.env,user.id))!)},201);
});
managedRoutes.post('/:id/invite',async c=>{await requestLimit(c,'managed-invite',8,600);await body(c,z.object({locale}).strict());const {user}=await target(c);const result=await inviteManaged(c.env,c.get('user')!,user);return c.json(result,result.emailAccepted?200:503);});
managedRoutes.post('/:id/media',async c=>{
 const {user,site}=await target(c),actor=c.get('user')!;if(!c.env.MEDIA)fail('SERVICE_UNAVAILABLE',503);await requestLimit(c,'managed-media',12,60);
 if(Number(c.req.header('Content-Length')??0)>MAX_IMAGE_BYTES+100000)fail('MEDIA_INVALID',413);
 let form:FormData;try{form=await c.req.formData();}catch{fail('MEDIA_INVALID');}
 const revision=Number(form.get('revision'));if(!form.has('revision')||!Number.isInteger(revision)||revision<0||revision!==site.revision)fail('CONFLICT',409);
 const file=form.get('file');if(!file||typeof file==='string'||typeof file.arrayBuffer!=='function')fail('MEDIA_INVALID');if(file.size>MAX_IMAGE_BYTES)fail('MEDIA_INVALID',413);if(file.type!=='image/webp')fail(['image/jpeg','image/png'].includes(file.type)?'MEDIA_CONVERT':'MEDIA_INVALID',415);
 const bytes=new Uint8Array(await file.arrayBuffer()),size=inspectWebP(bytes);if(!size)fail('MEDIA_INVALID',415);
 const id=crypto.randomUUID().replace(/-/g,''),key=`private/${user.id}/${crypto.randomUUID()}.webp`,live=custodySQL(actor.id,user.id),p=and(live,{sql:'EXISTS(SELECT 1 FROM sites WHERE id=? AND owner_id=? AND revision=?)',args:[site.id,user.id,revision]});
 try{await c.env.MEDIA.put(key,bytes,{httpMetadata:{contentType:'image/webp'},customMetadata:{owner:user.id,id}});}catch(error){await auditOnly(c.env,{actor:actor.id,action:'managed.media_upload',object:id,outcome:'storage_failed'}).catch(()=>{});throw error;}
 try{await auditedBatch(c.env,{actor:actor.id,action:'managed.media_upload',object:id},p,eventId=>{const g=gate(eventId);return [c.env.DB.prepare(`INSERT INTO media(id,user_id,object_key,mime,bytes,width,height,created_at) SELECT ?,?,?,'image/webp',?,?,?,? WHERE ${p.sql} AND ${g.sql}`).bind(id,user.id,key,bytes.length,size.width,size.height,now(),...p.args??[],...g.args)];});}
 catch(error){try{await c.env.MEDIA.delete(key);}catch{await auditOnly(c.env,{actor:actor.id,action:'managed.media_cleanup',object:id,outcome:'storage_pending'}).catch(()=>{});}throw error;}
 return c.json({media:{id,url:`/api/media/${id}`,width:size.width,height:size.height,bytes:bytes.length}},201);
});
