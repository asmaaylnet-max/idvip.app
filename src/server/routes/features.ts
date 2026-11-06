import {Hono} from 'hono';
import {z} from 'zod';
import {type AppEnv,authenticated,staff,root,body,fail,now} from '../security';
import {auditedBatch,and,gate,staffSQL,rootSQL} from '../services/audit';

export interface Feature {id:string;sortOrder:number;titleAr:string;titleEn:string;bodyAr:string;bodyEn:string;published:boolean;updatedAt:string;}
interface FeatureRow {id:string;sort_order:number;title_ar:string;title_en:string;body_ar:string;body_en:string;published:number;updated_at:number;}
const idSchema=z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const locale=z.enum(['ar','en']).optional();
export const featureSaveSchema=z.object({id:idSchema,action:z.literal('save').optional(),sortOrder:z.number().int().min(0).max(9999),titleAr:z.string().trim().min(1).max(300),titleEn:z.string().trim().min(1).max(300),bodyAr:z.string().trim().min(1).max(6000),bodyEn:z.string().trim().min(1).max(6000),published:z.boolean(),locale}).strict();
const deleteSchema=z.object({id:idSchema,action:z.literal('delete'),locale}).strict();
function toFeature(r:FeatureRow):Feature {return{id:r.id,sortOrder:r.sort_order,titleAr:r.title_ar,titleEn:r.title_en,bodyAr:r.body_ar,bodyEn:r.body_en,published:!!r.published,updatedAt:new Date(r.updated_at*1000).toISOString()};}
export const featureRoutes=new Hono<AppEnv>();
featureRoutes.get('/',async c=>{
 const rows=await c.env.DB.prepare('SELECT * FROM features WHERE published=1 ORDER BY sort_order,id LIMIT 100').all<FeatureRow>();
 return c.json({features:rows.results.map(toFeature)});
});
export const adminFeatureRoutes=new Hono<AppEnv>();
adminFeatureRoutes.use('*',authenticated,staff);
adminFeatureRoutes.get('/',async c=>{
 const rows=await c.env.DB.prepare('SELECT * FROM features ORDER BY sort_order,id LIMIT 100').all<FeatureRow>();
 return c.json({features:rows.results.map(toFeature)});
});
adminFeatureRoutes.put('/',async c=>{
 const data=await body(c,z.union([featureSaveSchema,deleteSchema])),actor=c.get('user')!;
 if(data.action==='delete'){
  if(!['owner','principal'].includes(actor.role))fail('FORBIDDEN',403);
  await removeFeature(c,data.id);return c.json({ok:true});
 }
 const existing=await c.env.DB.prepare('SELECT id FROM features WHERE id=?').bind(data.id).first();
 const capacity=existing?{sql:'EXISTS(SELECT 1 FROM features WHERE id=?)',args:[data.id]}:{sql:'NOT EXISTS(SELECT 1 FROM features WHERE id=?) AND (SELECT count(*) FROM features)<100',args:[data.id]};
 await auditedBatch(c.env,{actor:actor.id,action:'feature.save',object:data.id},and(staffSQL(actor),capacity),eventId=>{
  const g=gate(eventId);
  return[c.env.DB.prepare(`INSERT INTO features(id,sort_order,title_ar,title_en,body_ar,body_en,published,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE ${g.sql} ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order,title_ar=excluded.title_ar,title_en=excluded.title_en,body_ar=excluded.body_ar,body_en=excluded.body_en,published=excluded.published,updated_at=excluded.updated_at`).bind(data.id,data.sortOrder,data.titleAr,data.titleEn,data.bodyAr,data.bodyEn,data.published?1:0,now(),...g.args)];
 });
 const row=await c.env.DB.prepare('SELECT * FROM features WHERE id=?').bind(data.id).first<FeatureRow>();if(!row)fail('CONFLICT',409);
 return c.json({feature:toFeature(row)});
});
async function removeFeature(c:Parameters<typeof body>[0],id:string){
 if(!idSchema.safeParse(id).success)fail('INVALID_INPUT');
 if(!await c.env.DB.prepare('SELECT id FROM features WHERE id=?').bind(id).first())fail('NOT_FOUND',404);
 await auditedBatch(c.env,{actor:c.get('user')!.id,action:'feature.delete',object:id},and(rootSQL(c.get('user')!),{sql:'EXISTS(SELECT 1 FROM features WHERE id=?)',args:[id]}),eventId=>{
  const g=gate(eventId);return[c.env.DB.prepare(`DELETE FROM features WHERE id=? AND ${g.sql}`).bind(id,...g.args)];
 });
}
adminFeatureRoutes.delete('/:id',root,async c=>{await removeFeature(c,c.req.param('id'));return c.json({ok:true});});
