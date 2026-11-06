import {z} from 'zod';
import {EMPTY_PROFILE, socialNames, type ProfileData,type Site,type PublicProfile} from '../../shared/types';
import {fail,type Env} from '../security';
const short=z.string().max(240),text=z.string().max(6000),url=z.string().max(2048).refine(value=>{if(!value)return true;try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}});
export const MEDIA_BRAND_PATHS = new Set(['dark','light'].flatMap(t=>[...['192','384','512','full'].map(s=>`/brand/logo-${t}-${s}.webp`),...['768','1280','full'].map(s=>`/brand/cover-${t}-${s}.webp`)]));
export function mediaId(value:string){const match=/^\/api\/media\/([A-Za-z0-9_-]{24,80})$/.exec(value);return match?.[1]??null;}
const mediaURL=z.string().max(200).refine(v=>!v||MEDIA_BRAND_PATHS.has(v)||!!mediaId(v));
const timeline=z.object({title:short,organization:short,start:z.string().max(40),end:z.string().max(40),description:text}).strict();
const mediaItem=z.object({url:mediaURL,title:short,description:text}).strict();
const link=z.object({title:short,url,description:text.optional()}).strict();
export const HIDEABLE_FIELDS=Object.keys(EMPTY_PROFILE).filter(v=>v!=='hidden');
const hidden=z.array(z.string().refine(v=>HIDEABLE_FIELDS.includes(v))).max(HIDEABLE_FIELDS.length).refine(v=>new Set(v).size===v.length);
export const profileSchema=z.object({
 name:short,email:z.string().max(254).refine(v=>!v||z.string().email().safeParse(v).success),whatsapp:z.string().max(32).regex(/^[+\d ()-]*$/),phone:z.string().max(32).regex(/^[+\d ()-]*$/),specialty:short,country:short,city:short,bio:text,
 experience:z.array(timeline).max(30),education:z.array(timeline).max(30),training:z.array(timeline).max(30),languages:z.array(z.object({name:short,level:z.number().min(0).max(100)}).strict()).max(30),
 skills:z.array(short).max(60),awards:z.array(timeline).max(30),hobbies:z.array(short).max(30),note:text,
 workSamples:z.array(mediaItem).max(3),proofs:z.array(mediaItem).max(3),youtube:url.refine(v=>{if(!v)return true;try{return ['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(new URL(v).hostname);}catch{return false;}}),
 videoLinks:z.array(link).max(7),links:z.array(link).max(3),socials:z.object(Object.fromEntries(socialNames.map(n=>[n,url.optional()])) as Record<typeof socialNames[number],z.ZodOptional<typeof url>>).strict(),logo:mediaURL,cover:mediaURL,hidden
}).strict();
export const hiddenSchema=hidden;
export interface SiteRow {id:string;owner_id:string;slug:string;language:'ar'|'en';status:Site['status'];draft_json:string;revision:number;published_json:string|null;published_revision:number|null;pending_review:string|null;visible:number;discoverable:number;privacy_hidden:string;created_at:number;updated_at:number;}
export function toSite(row:SiteRow):Site{return{id:row.id,ownerId:row.owner_id,slug:row.slug,language:row.language,status:row.status,draft:JSON.parse(row.draft_json) as ProfileData,published:row.published_json?JSON.parse(row.published_json) as ProfileData:null,revision:row.revision,publishedRevision:row.published_revision,pendingReview:row.pending_review,visible:!!row.visible,discoverable:!!row.discoverable,privacyHidden:JSON.parse(row.privacy_hidden) as string[]};}
export async function ownSite(env:Env,userId:string){return env.DB.prepare('SELECT * FROM sites WHERE owner_id=?').bind(userId).first<SiteRow>();}
export function filterProfile(data:ProfileData,privacyHidden:string[]=[]):ProfileData {
 const result=structuredClone(data);const blank=structuredClone(EMPTY_PROFILE);
 for(const key of new Set([...data.hidden,...privacyHidden])){if(HIDEABLE_FIELDS.includes(key))(result as unknown as Record<string,unknown>)[key]=(blank as unknown as Record<string,unknown>)[key];}
 // Defaults are not disclosed for a hidden social field.
 if([...data.hidden,...privacyHidden].includes('socials'))result.socials={};
 result.hidden=[...new Set([...data.hidden,...privacyHidden])];return result;
}
export function publicProfile(row:SiteRow,publicId?:number):PublicProfile|null {if(!row.published_json||!row.visible||row.status==='suspended')return null;return{slug:row.slug,language:row.language,data:filterProfile(JSON.parse(row.published_json) as ProfileData,JSON.parse(row.privacy_hidden) as string[]),...(publicId?{publicId}:{})};}
export function referencedMedia(data:ProfileData){return [...new Set([data.logo,data.cover,...data.workSamples.map(v=>v.url),...data.proofs.map(v=>v.url)].map(mediaId).filter((v):v is string=>!!v))];}
export async function validateMediaOwnership(env:Env,userId:string,data:ProfileData){const ids=referencedMedia(data);if(!ids.length)return;const records=await env.DB.prepare(`SELECT id FROM media WHERE user_id=? AND id IN (${ids.map(()=>'?').join(',')})`).bind(userId,...ids).all<{id:string}>();if(records.results.length!==ids.length)fail('MEDIA_OWNERSHIP',403);}
export function visibilityShrinks(oldHidden:string[],newHidden:string[]){return oldHidden.every(key=>newHidden.includes(key));}
export function draftCAS(current:number,expected:number){return Number.isInteger(expected)&&current===expected;}
export function canDecideReview(review:{status:string;id:string;siteId:string},site:{id:string;pendingReview:string|null}){return review.status==='pending'&&review.siteId===site.id&&review.id===site.pendingReview;}
