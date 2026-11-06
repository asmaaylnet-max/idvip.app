import {z} from 'zod';
import {type Env,type UserRow,RESERVED_SLUGS,validSlug,fail,now} from '../security';
import {auditedBatch,and,gate,rootSQL,type Predicate} from './audit';

export interface ReservedName {slug:string;type:string;reason:string;fixed:boolean;updatedAt:string|null;}
interface ReservedRow {slug:string;type:string;reason:string;updated_at:number;}
const kind=z.string().trim().min(1).max(40).refine(v=>v!=='fixed_reserved'&&!/[\u0000-\u001f\u007f]/.test(v));
export const reserveSchema=z.object({
 slug:z.string().trim().toLowerCase().min(1).max(63),
 type:kind.default('custom'),reason:z.string().trim().max(500).default(''),
 action:z.enum(['reserve','release']).default('reserve'),locale:z.enum(['ar','en']).optional(),
}).strict();
export type ReserveInput=z.infer<typeof reserveSchema>;
const toReserve=(r:ReservedRow):ReservedName=>({slug:r.slug,type:r.type,reason:r.reason,fixed:false,updatedAt:new Date(r.updated_at*1000).toISOString()});

/** Add to the live SQL predicate of EVERY slug allocation/verification path. */
export function unreservedNameSQL(slug:string):Predicate {
 return {sql:'NOT EXISTS(SELECT 1 FROM reserved_names WHERE slug=?)',args:[slug]};
}
/** Availability alone is advisory; mutations must also use unreservedNameSQL. */
export async function isReservedName(env:Env,slug:string):Promise<boolean> {
 return !validSlug(slug)||!!await env.DB.prepare('SELECT slug FROM reserved_names WHERE slug=?').bind(slug).first();
}
export async function listReservedNames(env:Env):Promise<ReservedName[]> {
 const rows=await env.DB.prepare('SELECT slug,type,reason,updated_at FROM reserved_names ORDER BY slug').all<ReservedRow>();
 return [...[...RESERVED_SLUGS].map(slug=>({slug,type:'fixed_reserved',reason:'',fixed:true,updatedAt:null})),...rows.results.filter(r=>!RESERVED_SLUGS.has(r.slug)).map(toReserve)].sort((a,b)=>a.slug.localeCompare(b.slug));
}
function expectedRow(slug:string,row:ReservedRow|null):Predicate {
 return row?{sql:'EXISTS(SELECT 1 FROM reserved_names WHERE slug=? AND type=? AND reason=? AND updated_at=?)',args:[slug,row.type,row.reason,row.updated_at]}:unreservedNameSQL(slug);
}
export async function changeReservedName(env:Env,actor:UserRow,input:ReserveInput):Promise<ReservedName|null> {
 // Validate in the service too, rather than trusting only a route or a future caller.
 const parsed=reserveSchema.safeParse(input);if(!parsed.success)fail('INVALID_INPUT');const data=parsed.data;
 if(!['owner','principal'].includes(actor.role))fail('FORBIDDEN',403);
 if(RESERVED_SLUGS.has(data.slug))fail('FORBIDDEN',403);
 if(!validSlug(data.slug))fail('SLUG_UNAVAILABLE',409);
 const old=await env.DB.prepare('SELECT slug,type,reason,updated_at FROM reserved_names WHERE slug=?').bind(data.slug).first<ReservedRow>();
 if(data.action==='release'&&!old)fail('NOT_FOUND',404);
 const time=now();
 const vacant:Predicate={sql:'NOT EXISTS(SELECT 1 FROM sites WHERE slug=?) AND NOT EXISTS(SELECT 1 FROM slug_reservations WHERE slug=? AND expires_at>?)',args:[data.slug,data.slug,time]};
 // These checks execute in the SAME batch as the audit gate and the write.
 // In particular, an OTP reservation may not be displaced before expiry.
 const predicate=and(rootSQL(actor),expectedRow(data.slug,old),...(data.action==='reserve'?[vacant]:[]));
 await auditedBatch(env,{actor:actor.id,action:data.action==='release'?'reserve.release':'reserve.save',object:data.slug},predicate,eventId=>{
  const g=gate(eventId);
  if(data.action==='release')return[env.DB.prepare(`DELETE FROM reserved_names WHERE slug=? AND ${g.sql}`).bind(data.slug,...g.args)];
  return[env.DB.prepare(`INSERT INTO reserved_names(slug,type,reason,updated_at) SELECT ?,?,?,? WHERE ${g.sql} ON CONFLICT(slug) DO UPDATE SET type=excluded.type,reason=excluded.reason,updated_at=excluded.updated_at`).bind(data.slug,data.type,data.reason,time,...g.args)];
 });
 return data.action==='release'?null:toReserve({slug:data.slug,type:data.type,reason:data.reason,updated_at:time});
}
