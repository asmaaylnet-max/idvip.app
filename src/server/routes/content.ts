import {Hono} from 'hono';
import {z} from 'zod';
import {type AppEnv,authenticated,body,fail,now} from '../security';
import {toBlog} from './admin';
import {auditedBatch,gate} from '../services/audit';
export const blogRoutes=new Hono<AppEnv>();
blogRoutes.get('/',async c=>{const posts=await c.env.DB.prepare('SELECT * FROM blogs WHERE published=1 ORDER BY updated_at DESC LIMIT 100').all<Record<string,unknown>>();return c.json({posts:posts.results.map(toBlog)});});
blogRoutes.get('/:slug',async c=>{const post=await c.env.DB.prepare('SELECT * FROM blogs WHERE slug=? AND published=1').bind(c.req.param('slug')).first<Record<string,unknown>>();if(!post)fail('NOT_FOUND',404);return c.json({post:toBlog(post)});});
export const notificationRoutes=new Hono<AppEnv>();
notificationRoutes.use('*',authenticated);
notificationRoutes.get('/',async c=>{const result=await c.env.DB.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(c.get('user')!.id).all<{id:string;title:string;body:string;type:'normal'|'special';created_at:number;read_at:number|null;heard_at:number|null}>();return c.json({notifications:result.results.map(r=>({id:r.id,title:r.title,body:r.body,type:r.type??'normal',createdAt:new Date(r.created_at*1000).toISOString(),read:!!r.read_at,heard:!!r.heard_at}))});});
for(const action of ['read','heard'] as const){notificationRoutes.post('/:id/'+action,async c=>{await body(c,z.object({locale:z.enum(['ar','en']).optional()}).strict());const user=c.get('user')!,id=c.req.param('id')!;if(!await c.env.DB.prepare('SELECT id FROM notifications WHERE id=? AND user_id=?').bind(id,user.id).first())fail('NOT_FOUND',404);await auditedBatch(c.env,{actor:user.id,action:'notification.'+action,object:id},{sql:"EXISTS(SELECT 1 FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.id=? AND n.user_id=? AND u.status='active')",args:[id,user.id]},eventId=>{const g=gate(eventId);return[c.env.DB.prepare(`UPDATE notifications SET ${action}_at=COALESCE(${action}_at,?) WHERE id=? AND user_id=? AND ${g.sql}`).bind(now(),id,user.id,...g.args??[])];});return c.json({ok:true});});}
async function remove(c:Parameters<typeof body>[0],id?:string){const user=c.get('user')!;const all=!id||id==='all';if(!all&&!await c.env.DB.prepare('SELECT id FROM notifications WHERE id=? AND user_id=?').bind(id,user.id).first())fail('NOT_FOUND',404);await auditedBatch(c.env,{actor:user.id,action:all?'notifications.delete_all':'notification.delete',object:all?user.id:id!},{sql:all?"EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')":"EXISTS(SELECT 1 FROM notifications WHERE id=? AND user_id=?)",args:all?[user.id]:[id,user.id]},eventId=>{const g=gate(eventId);return[c.env.DB.prepare(`DELETE FROM notifications WHERE user_id=? ${all?'':'AND id=?'} AND ${g.sql}`).bind(user.id,...(all?[]:[id]),...g.args??[])];});return c.json({ok:true});}
notificationRoutes.delete('/:id',c=>remove(c,c.req.param('id')));
notificationRoutes.delete('/',c=>remove(c));
