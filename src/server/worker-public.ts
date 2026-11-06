import {fillHTML,pathFromURL} from './public-html';
interface Env {ASSETS:Fetcher;DB:D1Database;PUBLIC_ORIGIN:string;PHASE:string}
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url);const path=pathFromURL(url);
 if(url.pathname==='/health')return Response.json({ok:true,phase:'1',service:'VIP'});
 if(url.pathname==='/api/session')return Response.json({user:null,csrf:''},{headers:{'Cache-Control':'no-store'}});
 if(url.pathname==='/api/search')return Response.json({profiles:[]},{headers:{'Cache-Control':'no-store'}});
 if(url.pathname==='/api/blogs')return Response.json({posts:[]},{headers:{'Cache-Control':'no-store'}});
 if(url.pathname==='/api/settings')return Response.json({homeLocked:false,platformLocked:false},{headers:{'Cache-Control':'no-store'}});
 if(url.pathname.startsWith('/api/'))return Response.json({error:'هذه الوظيفة تجهز في المرحلة التالية. / This feature is being prepared in the next phase.',code:'PHASE_GATE'},{status:503,headers:{'Cache-Control':'no-store'}});
 if(url.pathname==='/robots.txt')return new Response('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /account\nDisallow: /preview\nDisallow: /review/\nSitemap: https://idvip.app/sitemap.xml\n',{headers:{'Content-Type':'text/plain'}});
 if(url.pathname==='/sitemap.xml')return new Response('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+['','search','features','about','privacy','terms','blog'].map(s=>'<url><loc>https://'+(s?s+'.':'')+'idvip.app/</loc></url>').join('')+'</urlset>',{headers:{'Content-Type':'application/xml'}});
 const isAsset=/^\/(assets|brand|fonts)\//.test(url.pathname)||['/manifest.webmanifest','/sw.js','/manus-routes.json','/favicon.ico'].includes(url.pathname);
 if(isAsset){const response=await env.ASSETS.fetch(request);const r=new Response(response.body,response);r.headers.set('X-Content-Type-Options','nosniff');r.headers.set('Cache-Control',url.pathname.startsWith('/assets/')?'public,max-age=31536000,immutable':'public,max-age=300');return r;}
 if(request.method!=='GET')return new Response('Method not allowed',{status:405});
 const template=await env.ASSETS.fetch(new Request(new URL('/index.html',url).toString()));
 if(!template.ok)return new Response('VIP unavailable',{status:503});
 const html=fillHTML(await template.text(),url);
 return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-VIP-Phase':'1'}});
}};
