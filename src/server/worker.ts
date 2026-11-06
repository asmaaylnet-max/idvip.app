import {apiApp} from './api';
import {type Env as APIEnv, localized, rateLimit} from './security';
import {fillHTML,pathFromURL,escapeHTML} from './public-html';
import {publicProfile,type SiteRow} from './services/profiles';
import {buildVCard, renderProfileDocument, publicProfileData, visibleField} from '../shared/profile-output';
import {demoProfile} from '../shared/demo';
import type {PublicProfile,Theme,Lang} from '../shared/types';

interface BrowserBinding {quickAction(action:'pdf',options:Record<string,unknown>):Promise<Response>}
interface Env extends APIEnv {ASSETS:Fetcher;PHASE:string;BROWSER?:BrowserBinding}
const aliases:Record<string,string>={create:'/create',admin:'/admin',account:'/account',login:'/login',register:'/create'};
const pageHosts=new Set(['search','features','blog','about','terms','privacy','auth','test']);
function responseHeaders(privatePage=false){return {'Content-Type':'text/html; charset=utf-8','Cache-Control':privatePage?'private,no-store':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; form-action 'self'",'Permissions-Policy':'camera=(), microphone=(self), geolocation=()'};}
async function loadPublic(env:Env,slug:string,lang:Lang):Promise<PublicProfile|null>{
 if(slug==='test')return {slug:'test',language:lang,data:demoProfile(lang),isDemo:true};
 const row=await env.DB.prepare("SELECT s.*,u.public_id FROM sites s JOIN users u ON u.id=s.owner_id WHERE s.slug=? AND u.status='active'").bind(slug.toLowerCase()).first<SiteRow&{public_id:number}>();
 return row?publicProfile(row,row.public_id):null;
}
function profileHTML(profile:PublicProfile,theme:Theme){
 const d=publicProfileData(profile.data);const h=escapeHTML;const sections:[string,string][]=[[profile.language==='ar'?'نبذة مهنية':'Professional summary',d.bio],[profile.language==='ar'?'التخصص':'Specialty',d.specialty],[profile.language==='ar'?'ملاحظة':'Note',d.note]];
 const cover=visibleField(d,'cover')?(d.cover||`/brand/cover-${theme}-1280.webp`):'',logo=visibleField(d,'logo')?(d.logo||`/brand/logo-${theme}-384.webp`):'';
 const timeline=(title:string,items:typeof d.experience)=>items.length?`<section class="profile-card"><h2>${h(title)}</h2>${items.map(x=>`<article><h3>${h(x.title)}</h3><p>${h(x.organization)}</p><p>${h([x.start,x.end].filter(Boolean).join(' — '))}</p><p>${h(x.description)}</p></article>`).join('')}</section>`:'';
 const en=profile.language==='en';
 return `<main class="vip-profile" lang="${profile.language}" dir="${en?'ltr':'rtl'}"><header class="profile-hero profile-card">${cover?`<img class="profile-cover" src="${h(cover)}" alt="" width="1280" height="427"/>`:''}<div class="profile-identity with-cover">${logo?`<img class="profile-logo" src="${h(logo)}" alt="VIP" width="192" height="192"/>`:''}<div><h1>${h(d.name||'VIP')}</h1><p>${h(d.specialty)}</p><p>${h([d.city,d.country].filter(Boolean).join(' · '))}</p></div></div></header>${sections.filter(([,v])=>v).map(([t,v])=>`<section class="profile-card"><h2>${h(t)}</h2><p>${h(v)}</p></section>`).join('')}${timeline(en?'Experience':'الخبرة المهنية',d.experience)}${timeline(en?'Education':'التعليم',d.education)}${timeline(en?'Training & development':'التدريب والتطوير',d.training)}${timeline(en?'Awards & recognition':'الأوسمة والجوائز',d.awards)}${d.skills.length?`<section class="profile-card"><h2>${en?'Skills':'المهارات'}</h2><p>${h(d.skills.join(' · '))}</p></section>`:''}</main>`;
}
function redirect(url:URL,target:string,status=302){return new Response(null,{status,headers:{Location:target,'Cache-Control':'no-store'}});}
async function handle(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
 const url=new URL(request.url),host=url.hostname,first=host.split('.')[0],path=pathFromURL(url),lang:Lang=url.searchParams.get('lang')==='en'?'en':'ar',theme:Theme=url.searchParams.get('theme')==='light'?'light':'dark';
 if(url.pathname==='/health')return Response.json({ok:true,phase:env.PHASE,service:'VIP',database:!!env.DB,media:!!env.MEDIA,emailPrimary:!!env.RESEND_API_KEY,emailBackup:!!env.EMAIL,pdf:!!env.BROWSER},{headers:{'Cache-Control':'no-store'}});
 if(host.endsWith('.idvip.app')&&aliases[first]&&!url.pathname.startsWith('/api/')&&!/^\/(brand|assets|fonts)\//.test(url.pathname))return redirect(url,'https://auth.idvip.app'+(url.pathname==='/'?aliases[first]:url.pathname)+url.search);
 if(host!=='auth.idvip.app'&&/^\/(create|login|account|admin|preview|review)(\/|$)/.test(url.pathname))return redirect(url,'https://auth.idvip.app'+url.pathname+url.search);
 if(/^\/api\/(?:export|vcard)\//.test(url.pathname)){
  if(request.method!=='GET')return new Response(null,{status:405});
  const match=/^\/api\/(export|vcard)\/([a-z0-9-]{1,63})(?:\/(profile|ats)\.pdf)?$/.exec(url.pathname);if(!match)return new Response(null,{status:404});
  const profile=await loadPublic(env,match[2],lang);if(!profile)return Response.json({error:localized('NOT_FOUND',lang)},{status:404,headers:{'Cache-Control':'no-store'}});
  if(match[1]==='vcard')return new Response(buildVCard(profile.data),{headers:{'Content-Type':'text/vcard; charset=utf-8','Content-Disposition':`attachment; filename="${profile.slug}.vcf"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(!match[3]||!env.BROWSER)return Response.json({error:localized('SERVICE_UNAVAILABLE',lang)},{status:503});
  await rateLimit(env,'pdf:'+profile.slug+':'+(request.headers.get('CF-Connecting-IP')||'unknown'),4,60);
  const html=renderProfileDocument(profile.data,profile.isDemo?lang:profile.language,theme,match[3] as 'profile'|'ats');
  const result=await env.BROWSER.quickAction('pdf',{html,emulateMediaType:'print',gotoOptions:{waitUntil:'networkidle0',timeout:20000},pdfOptions:{format:'a4',printBackground:true,preferCSSPageSize:true,tagged:true,outline:true},allowRequestPattern:['^https://idvip\\.app/(?:brand|fonts|api/media)/'],rejectResourceTypes:['script','media','xhr','fetch','websocket'],actionTimeout:30000});
  if(!result.ok||!result.headers.get('content-type')?.includes('application/pdf'))return Response.json({error:localized('SERVICE_UNAVAILABLE',lang)},{status:503});
  const bytes=await result.arrayBuffer();if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')return new Response(null,{status:503});
  return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${profile.slug}-${match[3]}-${lang}.pdf"`,'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}});
 }
 if(url.pathname.startsWith('/api/')){
  const apiURL=new URL(url);apiURL.pathname=url.pathname.slice(4)||'/';
  return apiApp.fetch(new Request(apiURL,request),env,ctx);
 }
 if(/^\/c\/\d+$/.test(url.pathname)){
  const row=await env.DB.prepare("SELECT s.*,u.public_id FROM sites s JOIN users u ON u.id=s.owner_id WHERE u.public_id=? AND u.status='active'").bind(Number(url.pathname.slice(3))).first<SiteRow&{public_id:number}>();
  const p=row?publicProfile(row,row.public_id):null;return p?redirect(url,`https://${p.slug}.idvip.app/${url.search}`,307):new Response('VIP — unavailable',{status:404,headers:{'Cache-Control':'no-store'}});
 }
 if(/^\/r\/\d+$/.test(url.pathname))return redirect(url,'https://idvip.app/c/'+url.pathname.slice(3)+url.search,307);
 if(url.pathname==='/robots.txt')return new Response(`User-agent: *\n${first==='auth'?'Disallow: /':'Allow: /\nDisallow: /api/\nDisallow: /review/\nDisallow: /preview'}\nSitemap: https://idvip.app/sitemap.xml\n`,{headers:{'Content-Type':'text/plain'}});
 if(url.pathname==='/sitemap.xml'){
  const rows=await env.DB.prepare("SELECT s.slug FROM sites s JOIN users u ON u.id=s.owner_id WHERE s.visible=1 AND s.discoverable=1 AND s.status<>'suspended' AND s.published_json IS NOT NULL AND u.status='active' ORDER BY s.slug LIMIT 5000").all<{slug:string}>();
  const pages=['','search','features','about','privacy','terms','blog','test'].map(s=>`https://${s?s+'.':''}idvip.app/`);return new Response('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+[...pages,...rows.results.map(r=>`https://${r.slug}.idvip.app/`)].map(p=>`<url><loc>${escapeHTML(p)}</loc></url>`).join('')+'</urlset>',{headers:{'Content-Type':'application/xml','Cache-Control':'no-cache'}});
 }
 const isAsset=/^\/(assets|brand|fonts)\//.test(url.pathname)||['/manifest.webmanifest','/sw.js','/manus-routes.json','/favicon.ico'].includes(url.pathname);
 if(isAsset){const source=await env.ASSETS.fetch(request);const response=new Response(source.body,source);response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Cache-Control',url.pathname.startsWith('/assets/')?'public,max-age=31536000,immutable':'public,max-age=300');return response;}
 if(request.method!=='GET'&&request.method!=='HEAD')return new Response(null,{status:405});
 const settings=await env.DB.prepare('SELECT home_locked,platform_locked FROM settings WHERE id=1').first<{home_locked:number;platform_locked:number}>();
 const rightsPage=['/privacy','/terms'].includes(path);if((settings?.platform_locked&&!rightsPage&&first!=='auth')||(settings?.home_locked&&host==='idvip.app'&&url.pathname==='/'))return new Response(`<html lang="${lang}" dir="${lang==='ar'?'rtl':'ltr'}"><body style="background:#101013;color:#e8cf8b;font-family:Arial;padding:3rem"><h1>VIP</h1><p>${lang==='ar'?'نجري تحسينات للخدمة. يمكنك الوصول إلى حسابك وحقوقك.':'Service improvements are in progress. Your account and rights remain accessible.'}</p><a style="color:inherit" href="https://auth.idvip.app/account">${lang==='ar'?'الحساب':'Account'}</a> · <a style="color:inherit" href="https://privacy.idvip.app/">${lang==='ar'?'الخصوصية':'Privacy'}</a></body></html>`,{status:503,headers:{...responseHeaders(true),'Retry-After':'120'}});
 const privatePage=first==='auth'||/^\/(preview|review|admin|account|login|create)(\/|$)/.test(path);
 let profile:PublicProfile|null=null,body:string|undefined,extraHead='';
 if(path==='/test'||path.startsWith('/site/')){
  const slug=path==='/test'?'test':path.split('/')[2];profile=await loadPublic(env,slug,lang);
  if(!profile)return new Response(`<html lang="${lang}"><body><h1>VIP</h1><p>${localized('NOT_FOUND',lang)}</p></body></html>`,{status:404,headers:responseHeaders()});
  body=profileHTML(profile,theme);const d=profile.data;const title=d.name||'VIP';const description=(d.bio||d.specialty||'VIP').slice(0,200);
  extraHead=`<meta property="og:title" content="${escapeHTML(title)}"/><meta property="og:description" content="${escapeHTML(description)}"/><meta property="og:image" content="https://idvip.app/brand/logo-dark-512.webp"/><script type="application/ld+json">${JSON.stringify({'@context':'https://schema.org','@type':'ProfilePage',name:title,description,mainEntity:{'@type':'Person',name:title}}).replace(/</g,'\\u003c')}</script>`;
 }
 if(host.endsWith('.idvip.app')&&!pageHosts.has(first)&&!aliases[first]&&!path.startsWith('/site/')&&!isAsset)return new Response('VIP — unavailable',{status:404});
 const template=await env.ASSETS.fetch(new Request(new URL('/index.html',url)));if(!template.ok)return new Response('VIP unavailable',{status:503});
 let html=fillHTML(await template.text(),url,body,extraHead);if(profile)html=html.replace(/<title>.*?<\/title>/,`<title>${escapeHTML(profile.data.name||'VIP')} — VIP</title>`);
 return new Response(request.method==='HEAD'?null:html,{headers:{...responseHeaders(privatePage),'X-VIP-Phase':env.PHASE}});
}
export default {async fetch(request:Request,env:Env,ctx:ExecutionContext){try{return await handle(request,env,ctx);}catch(error){console.error('VIP_RUNTIME_FAILURE',error instanceof Error?error.name:'Error');return Response.json({error:'الخدمة غير متاحة مؤقتاً. / Service temporarily unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});}}};
