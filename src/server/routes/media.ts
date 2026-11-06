import {Hono} from 'hono';
import {type AppEnv,authenticated,requestLimit,fail,now,randomToken} from '../security';
import {type SiteRow,publicProfile,referencedMedia} from '../services/profiles';
import type {ProfileData} from '../../shared/types';
export const MAX_IMAGE_BYTES=8*1024*1024,MAX_IMAGE_PIXELS=32_000_000;
export interface WebPDimensions{width:number;height:number;}
const ascii=(bytes:Uint8Array,start:number,length:number)=>String.fromCharCode(...bytes.subarray(start,start+length));
export function inspectWebP(bytes:Uint8Array):WebPDimensions|null{
 if(bytes.byteLength<20||bytes.byteLength>MAX_IMAGE_BYTES||ascii(bytes,0,4)!=='RIFF'||ascii(bytes,8,4)!=='WEBP')return null;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(view.getUint32(4,true)!==bytes.byteLength-8)return null;
 let offset=12,dimension:WebPDimensions|null=null,canvas:WebPDimensions|null=null,images=0;
 while(offset+8<=bytes.length){const kind=ascii(bytes,offset,4),size=view.getUint32(offset+4,true),start=offset+8;if(size>bytes.length-start)return null;
 if(['ANIM','ANMF','EXIF','XMP ','ICCP'].includes(kind))return null;
 if(kind==='VP8X'){if(size!==10||canvas||bytes[start]&0x2e)return null;canvas={width:1+bytes[start+4]+(bytes[start+5]<<8)+(bytes[start+6]<<16),height:1+bytes[start+7]+(bytes[start+8]<<8)+(bytes[start+9]<<16)};}
 else if(kind==='VP8 '){if(size<10||(bytes[start]&1)!==0||ascii(bytes,start+3,3)!=='\x9d\x01\x2a')return null;images++;dimension={width:view.getUint16(start+6,true)&0x3fff,height:view.getUint16(start+8,true)&0x3fff};}
 else if(kind==='VP8L'){if(size<5||bytes[start]!==0x2f)return null;const bits=view.getUint32(start+1,true);if((bits>>>29)!==0)return null;images++;dimension={width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};}
 else if(kind!=='ALPH')return null;
 offset=start+size+(size%2);
 }
 if(offset!==bytes.length||images!==1||!dimension||!dimension.width||!dimension.height||dimension.width>8192||dimension.height>8192||dimension.width*dimension.height>MAX_IMAGE_PIXELS)return null;
 if(canvas&&(canvas.width!==dimension.width||canvas.height!==dimension.height))return null;return dimension;
}
interface MediaRow{id:string;user_id:string;object_key:string;mime:string;bytes:number;width:number;height:number;}
export const mediaRoutes=new Hono<AppEnv>();
mediaRoutes.post('/',authenticated,async c=>{
 if(!c.env.MEDIA)fail('SERVICE_UNAVAILABLE',503);
 await requestLimit(c,'media-upload',12,60);if(Number(c.req.header('Content-Length')??0)>MAX_IMAGE_BYTES+100000)fail('MEDIA_INVALID',413);
 let form:FormData;try{form=await c.req.formData();}catch{fail('MEDIA_INVALID');}
 const file=form.get('file');if(!file||typeof file==='string'||typeof file.arrayBuffer!=='function')fail('MEDIA_INVALID');if(file.size>MAX_IMAGE_BYTES)fail('MEDIA_INVALID',413);
 if(['image/jpeg','image/png'].includes(file.type))fail('MEDIA_CONVERT',415);if(file.type!=='image/webp')fail('MEDIA_INVALID',415);
 const bytes=new Uint8Array(await file.arrayBuffer()),dimensions=inspectWebP(bytes);if(!dimensions)fail('MEDIA_INVALID',415);
 const user=c.get('user')!,id=randomToken(24),key=`private/${user.id}/${randomToken(32)}.webp`;await c.env.MEDIA.put(key,bytes,{httpMetadata:{contentType:'image/webp'},customMetadata:{owner:user.id,id}});
 try{const result=await c.env.DB.prepare("INSERT INTO media(id,user_id,object_key,mime,bytes,width,height,created_at) SELECT ?,id,?,'image/webp',?,?,?,? FROM users WHERE id=? AND status='active'").bind(id,key,bytes.length,dimensions.width,dimensions.height,now(),user.id).run();if(!result.meta.changes){await c.env.MEDIA.delete(key);fail('UNAUTHORIZED',401);}}catch(e){await c.env.MEDIA.delete(key);throw e;}
 return c.json({media:{id,url:`/api/media/${id}`,width:dimensions.width,height:dimensions.height,bytes:bytes.length}},201);
});
mediaRoutes.get('/:id',async c=>{
 if(!c.env.MEDIA)fail('SERVICE_UNAVAILABLE',503);
 const media=await c.env.DB.prepare("SELECT m.* FROM media m JOIN users u ON u.id=m.user_id WHERE m.id=? AND u.status='active'").bind(c.req.param('id')).first<MediaRow>();if(!media)fail('NOT_FOUND',404);
 const user=c.get('user');let allowed=user?.id===media.user_id;
 const site=await c.env.DB.prepare('SELECT * FROM sites WHERE owner_id=?').bind(media.user_id).first<SiteRow>();
 if(!allowed&&site){const published=publicProfile(site);allowed=!!published&&referencedMedia(published.data).includes(media.id);}
 if(!allowed&&site&&user&&['owner','principal','moderator'].includes(user.role)){const reviews=await c.env.DB.prepare('SELECT data_json FROM reviews WHERE site_id=?').bind(site.id).all<{data_json:string}>();allowed=reviews.results.some(r=>referencedMedia(JSON.parse(r.data_json) as ProfileData).includes(media.id));}
 if(!allowed)fail('NOT_FOUND',404);
 const object=await c.env.MEDIA.get(media.object_key);if(!object)fail('NOT_FOUND',404);
 c.header('Content-Type','image/webp');c.header('Cache-Control','private, no-store');c.header('Content-Security-Policy',"default-src 'none'; sandbox");c.header('Cross-Origin-Resource-Policy','same-site');
 return c.body(object.body,{status:200,headers:{'Content-Length':String(object.size),'Content-Disposition':'inline'}});
});
