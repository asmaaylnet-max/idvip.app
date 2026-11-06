import {Hono} from 'hono';
import {z} from 'zod';
import {type AppEnv,authenticated,body,fail,now,randomToken,clearSessionCookie,stepUp,requestLimit} from '../security';
import {ownSite,toSite,profileSchema,validateMediaOwnership,type SiteRow,publicProfile,hiddenSchema,visibilityShrinks,referencedMedia} from '../services/profiles';
import {auditedBatch,and,gate} from '../services/audit';
import {deleteUser} from '../services/deletion';
export const siteRoutes=new Hono<AppEnv>();
siteRoutes.get('/me',authenticated,async c=>{const site=await ownSite(c.env,c.get('user')!.id);return c.json({site:site?toSite(site):null});});
siteRoutes.put('/me/draft',authenticated,async c=>{
 await requestLimit(c,'draft-save',60,60);const data=await body(c,z.object({data:profileSchema,revision:z.number().int().min(0),locale:z.enum(['ar','en']).optional()}).strict());const user=c.get('user')!,site=await ownSite(c.env,user.id);if(!site)fail('NOT_FOUND',404);
 if(site.revision!==data.revision)fail('CONFLICT',409);await validateMediaOwnership(c.env,user.id,data.data);
 const media=referencedMedia(data.data);const ownership=media.length?{sql:`(SELECT count(*) FROM media WHERE user_id=? AND id IN (${media.map(()=>'?').join(',')}))=?`,args:[user.id,...media,media.length]}:{sql:'1'};
 await auditedBatch(c.env,{actor:user.id,action:'site.draft_save',object:site.id},and({sql:"EXISTS(SELECT 1 FROM sites s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND s.owner_id=? AND s.revision=? AND u.status='active')",args:[site.id,user.id,data.revision]},ownership),eventId=>{const g=gate(eventId);return[c.env.DB.prepare(`UPDATE sites SET draft_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND ${g.sql}`).bind(JSON.stringify(data.data),now(),site.id,user.id,data.revision,...g.args??[])];});return c.json({site:toSite((await ownSite(c.env,user.id))!)});
});
siteRoutes.post('/me/submit',authenticated,async c=>{
 await requestLimit(c,'site-submit',8,600);await body(c,z.object({locale:z.enum(['ar','en']).optional()}).strict());const user=c.get('user')!,site=await ownSite(c.env,user.id);if(!site)fail('NOT_FOUND',404);const id=randomToken(24),time=now();
 await validateMediaOwnership(c.env,user.id,profileSchema.parse(JSON.parse(site.draft_json)));
 await auditedBatch(c.env,{actor:user.id,action:'site.submit',object:site.id},{sql:"EXISTS(SELECT 1 FROM sites s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND s.owner_id=? AND s.revision=? AND s.pending_review IS NULL AND u.status='active') AND NOT EXISTS(SELECT 1 FROM reviews WHERE site_id=? AND status='pending')",args:[site.id,user.id,site.revision,site.id]},eventId=>{const g=gate(eventId);return[
 c.env.DB.prepare(`INSERT INTO reviews(id,site_id,owner_id,revision,kind,data_json,privacy_json,disclosure_revision,created_at) SELECT ?,id,owner_id,revision,CASE WHEN published_json IS NULL THEN 'publish' ELSE 'edit' END,draft_json,privacy_hidden,disclosure_revision,? FROM sites WHERE id=? AND ${g.sql}`).bind(id,time,site.id,...g.args??[]),
 c.env.DB.prepare(`UPDATE sites SET pending_review=?,status=CASE WHEN published_json IS NULL THEN 'review' ELSE status END,updated_at=? WHERE id=? AND ${g.sql}`).bind(id,time,site.id,...g.args??[])
 ];});return c.json({reviewId:id,site:toSite((await ownSite(c.env,user.id))!)},201);
});
siteRoutes.post('/me/visibility',authenticated,async c=>{
 const data=await body(c,z.object({visible:z.boolean().optional(),discoverable:z.boolean().optional(),hidden:hiddenSchema.optional(),locale:z.enum(['ar','en']).optional()}).strict());const user=c.get('user')!,site=await ownSite(c.env,user.id);if(!site)fail('NOT_FOUND',404);
 const oldHidden=JSON.parse(site.privacy_hidden) as string[],newHidden=data.hidden??oldHidden;
 if(!visibilityShrinks(oldHidden,newHidden))fail('PRIVACY_REVIEW',409);
 if((data.visible===true||data.discoverable===true)&&(!site.published_json||site.status==='suspended'))fail('PRIVACY_REVIEW',409);
 const visible=data.visible??!!site.visible,discoverable=data.discoverable??!!site.discoverable;
 await auditedBatch(c.env,{actor:user.id,action:'site.visibility',object:site.id},{sql:"EXISTS(SELECT 1 FROM sites s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND s.owner_id=? AND s.privacy_hidden=? AND s.visible=? AND s.discoverable=? AND s.status=? AND u.status='active')",args:[site.id,user.id,site.privacy_hidden,site.visible,site.discoverable,site.status]},eventId=>{const g=gate(eventId);return[c.env.DB.prepare(`UPDATE sites SET visible=?,discoverable=?,privacy_hidden=?,disclosure_revision=disclosure_revision+1,status=CASE WHEN status='suspended' THEN status WHEN ?=0 AND published_json IS NOT NULL THEN 'hidden' WHEN ?=1 AND published_json IS NOT NULL THEN 'published' ELSE status END,updated_at=? WHERE id=? AND ${g.sql}`).bind(visible?1:0,discoverable?1:0,JSON.stringify(newHidden),visible?1:0,visible?1:0,now(),site.id,...g.args??[])];});return c.json({site:toSite((await ownSite(c.env,user.id))!)});
});
siteRoutes.delete('/me',authenticated,async c=>{stepUp(c);const user=c.get('user')!;const complete=await deleteUser(c.env,user,user.id,false,c.get('session')!.token_hash);clearSessionCookie(c);if(!complete)fail('DELETE_PENDING',503);return c.json({ok:true});});
siteRoutes.get('/:slug',async c=>{const row=await c.env.DB.prepare("SELECT s.*,u.public_id FROM sites s JOIN users u ON u.id=s.owner_id WHERE s.slug=? AND u.status='active'").bind(c.req.param('slug').toLowerCase()).first<SiteRow&{public_id:number}>();const profile=row?publicProfile(row,row.public_id):null;if(!profile)fail('NOT_FOUND',404);return c.json({profile});});
export const searchRoutes=new Hono<AppEnv>();
function publicField(key:string){return `CASE WHEN EXISTS(SELECT 1 FROM json_each(s.privacy_hidden) WHERE value='${key}') OR EXISTS(SELECT 1 FROM json_each(json_extract(s.published_json,'$.hidden')) WHERE value='${key}') THEN '' ELSE COALESCE(json_extract(s.published_json,'$.${key}'),'') END`;}
searchRoutes.get('/',async c=>{
 const query=z.object({q:z.string().max(100).optional(),country:z.string().max(240).optional(),city:z.string().max(240).optional(),specialty:z.string().max(240).optional()}).strict().safeParse(c.req.query());if(!query.success)fail('INVALID_INPUT');
 const clauses=["s.visible=1","s.discoverable=1","s.status<>'suspended'","s.published_json IS NOT NULL","u.status='active'"],args:unknown[]=[];
 for(const key of ['country','city','specialty'] as const){if(query.data[key]){clauses.push(`${publicField(key)}=? COLLATE NOCASE`);args.push(query.data[key]);}}
 if(query.data.q?.trim()){const escaped=query.data.q.trim().replace(/[\\%_]/g,'\\$&');clauses.push('('+['name','specialty','country','city','bio','skills'].map(key=>`${publicField(key)} LIKE ? ESCAPE '\\'`).join(' OR ')+')');args.push(...Array(6).fill('%'+escaped+'%'));}
 const rows=await c.env.DB.prepare(`SELECT s.*,u.public_id FROM sites s JOIN users u ON u.id=s.owner_id WHERE ${clauses.join(' AND ')} ORDER BY s.slug LIMIT 50`).bind(...args).all<SiteRow&{public_id:number}>();return c.json({profiles:rows.results.map(row=>publicProfile(row,row.public_id)).filter(Boolean)});
});
