const VERSION='vip-public-v2';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith('vip-public-')&&k!==VERSION)await caches.delete(k);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{const u=new URL(event.request.url);if(event.request.method!=='GET'||u.origin!==self.location.origin||!/^\/(brand|fonts|assets)\//.test(u.pathname))return;event.respondWith((async()=>{const c=await caches.open(VERSION);const hit=await c.match(event.request);if(hit)return hit;const r=await fetch(event.request);if(r.ok&&r.type!=='opaque')await c.put(event.request,r.clone());return r;})());});
const pushPath=value=>typeof value==='string'&&/^\/(?:account|admin)(?:\?[A-Za-z0-9_=&%-]*)?$/.test(value)?value:'/account';
self.addEventListener('push',event=>{
 let d;try{d=event.data?.json();}catch{return;}
 if(!d||typeof d.title!=='string'||!d.title.trim()||d.title.length>300||typeof d.body!=='string'||d.body.length>6000)return;
 const id=typeof d.notificationId==='string'&&/^[A-Za-z0-9_-]{16,80}$/.test(d.notificationId)?d.notificationId:undefined;
 event.waitUntil(self.registration.showNotification(d.title,{body:d.body,icon:'/brand/logo-dark-192.webp',badge:'/brand/logo-dark-192.webp',...(id?{tag:'vip-'+id}:{}),data:{url:pushPath(d.url),...(id?{notificationId:id}:{})}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();const target=new URL(pushPath(event.notification.data?.url),self.location.origin);
 event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows){const u=new URL(client.url);if(u.origin===target.origin&&u.pathname===target.pathname){await client.navigate(target.href);return client.focus();}}return self.clients.openWindow(target.href);})());
});
self.addEventListener('pushsubscriptionchange',event=>event.waitUntil((async()=>{for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true}))client.postMessage({type:'VIP_PUSH_SUBSCRIPTION_CHANGED'});})()));
