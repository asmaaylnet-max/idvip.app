import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {createServer as createViteServer} from 'vite';
import {getPlatformProxy,unstable_splitSqlQuery} from 'wrangler';
import {fillHTML} from './public-html';
import {apiApp} from './api';
import type {Env} from './security';
const publicOrigin=process.env.PREVIEW_ORIGIN||'https://8328-izf9nup0wm8tuk5k79m3j-b2281dcd.sg2.manus.computer';
const platform=await getPlatformProxy<Env>({persist:{path:'.wrangler/preview'},remoteBindings:false});
const env:Env={...platform.env,PUBLIC_ORIGIN:publicOrigin,COOKIE_MODE:'preview',RP_ID:new URL(publicOrigin).hostname};
await env.DB.prepare('CREATE TABLE IF NOT EXISTS __vip_preview_migrations(name TEXT PRIMARY KEY)').run();
for(const file of (await readdir('migrations')).filter(x=>x.endsWith('.sql')).sort()){if(await env.DB.prepare('SELECT name FROM __vip_preview_migrations WHERE name=?').bind(file).first())continue;const queries=unstable_splitSqlQuery(await readFile('migrations/'+file,'utf8')).filter(q=>!/^\s*PRAGMA\s+foreign_keys/i.test(q));await env.DB.batch([...queries.map(sql=>env.DB.prepare(sql)),env.DB.prepare('INSERT INTO __vip_preview_migrations(name) VALUES(?)').bind(file)]);}
const vite=await createViteServer({server:{middlewareMode:true,host:'0.0.0.0'},appType:'custom'});
const server=createServer(async(req,res)=>{
 try{
 if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,phase:2,database:'isolated-preview'}));return;}
 if(req.url?.startsWith('/api/')){
  const headers=new Headers();for(const [name,value]of Object.entries(req.headers)){if(value)headers.set(name,Array.isArray(value)?value.join(', '):value);}headers.delete('CF-Connecting-IP');
  const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>9*1024*1024){res.statusCode=413;res.end('Payload too large');return;}chunks.push(chunk);}
  const method=req.method||'GET';const request=new Request(publicOrigin+req.url.slice(4),{method,headers,...(!['GET','HEAD'].includes(method)?{body:Buffer.concat(chunks)}:{})});
  const response=await apiApp.fetch(request,env,platform.ctx);res.statusCode=response.status;response.headers.forEach((v,k)=>res.setHeader(k,v));res.end(Buffer.from(await response.arrayBuffer()));return;
 }
 vite.middlewares(req,res,async()=>{try{const url=new URL(req.url||'/',publicOrigin);const source=await readFile('index.html','utf8');const transformed=await vite.transformIndexHtml(req.url||'/',fillHTML(source,url));res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(transformed);}catch(e){vite.ssrFixStacktrace(e as Error);res.statusCode=500;res.end('VIP development error');console.error(e instanceof Error?e.name:'Error')}});
 }catch(e){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'Service temporarily unavailable',code:'SERVICE_UNAVAILABLE'}));console.error(e instanceof Error?e.name:'Error')}
});
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('VIP Preview ready on port '+(process.env.PORT||3000)+' — isolated D1, real API'));
async function shutdown(){server.close();await vite.close();await platform.dispose();process.exit(0)}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
