import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createServer as createViteServer} from 'vite';
import {fillHTML} from './public-html';
const vite=await createViteServer({server:{middlewareMode:true,host:'0.0.0.0'},appType:'custom'});
const server=createServer(async(req,res)=>{
 try{
 if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,phase:1}));return;}
 if(req.url?.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');const p=req.url.split('?')[0];if(p==='/api/session')res.end(JSON.stringify({user:null,csrf:''}));else if(p==='/api/search')res.end(JSON.stringify({profiles:[]}));else if(p==='/api/blogs')res.end(JSON.stringify({posts:[]}));else if(p==='/api/settings')res.end(JSON.stringify({homeLocked:false,platformLocked:false}));else{res.statusCode=503;res.end(JSON.stringify({error:'هذه الوظيفة تجهز في المرحلة التالية. / This feature is being prepared in the next phase.',code:'PHASE_GATE'}));}return;}
 vite.middlewares(req,res,async()=>{try{const url=new URL(req.url||'/',process.env.PUBLIC_ORIGIN||'http://localhost:3000');const source=await readFile('index.html','utf8');const transformed=await vite.transformIndexHtml(req.url||'/',fillHTML(source,url));res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.end(transformed);}catch(e){vite.ssrFixStacktrace(e as Error);res.statusCode=500;res.end('VIP development error');console.error(e)}});
 }catch(e){res.statusCode=500;res.end('VIP development error');console.error(e)}
});
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('VIP Preview ready on port '+(process.env.PORT||3000)));
