import {Hono} from 'hono';
import {type AppEnv,authenticated,staff,root,body} from '../security';
import {reserveSchema,listReservedNames,changeReservedName} from '../services/reserves';

// Mount at /admin/reserves; keep guards here even when mounted inside adminRoutes.
export const reserveRoutes=new Hono<AppEnv>();
reserveRoutes.use('*',authenticated,staff);
reserveRoutes.get('/',async c=>c.json({reserves:await listReservedNames(c.env)}));
reserveRoutes.post('/',root,async c=>{
 const data=await body(c,reserveSchema);
 const reserve=await changeReservedName(c.env,c.get('user')!,data);
 return c.json({ok:true,reserve});
});
reserveRoutes.delete('/:slug',root,async c=>{
 await changeReservedName(c.env,c.get('user')!,{slug:c.req.param('slug'),type:'custom',reason:'',action:'release'});
 return c.json({ok:true});
});
