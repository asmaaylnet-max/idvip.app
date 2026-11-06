import {useCallback,useEffect,useRef,useState} from 'react';
import {api,ApiError} from '../api';
import {useUI} from './Context';

interface Status {enabled:boolean;deviceCount:number;maxDevices:number;subscriptions:{id:string;createdAt:string}[]}
interface Saved {id:string;fingerprint:string}
/** Render only within UIContext, on authenticated platform account routes.
 * Uses the existing localized same-origin API/CSRF client. No permission prompt
 * or subscription mutation on mount. OS sounds are controlled by the OS/browser.
 */
export default function PushPermission(){
 const {user,text}=useUI();
 const [supported,setSupported]=useState(false),[permission,setPermission]=useState<NotificationPermission>('default');
 const [status,setStatus]=useState<Status|null>(null),[active,setActive]=useState(false),[localExists,setLocalExists]=useState(false);
 const [checking,setChecking]=useState(true),[busy,setBusy]=useState(false),[failure,setFailure]=useState(''),[notice,setNotice]=useState('');
 const memory=useRef<Saved|null>(null),generation=useRef(0),busyRef=useRef(false);
 busyRef.current=busy;
 const key=user?'vip-push-registration:'+user.id:'';
 const capable=()=>typeof window!=='undefined'&&window.isSecureContext&&'Notification'in window&&'serviceWorker'in navigator&&'PushManager'in window;
 const readSaved=useCallback(()=>{if(memory.current)return memory.current;try{const raw=localStorage.getItem(key);if(!raw)return null;const value=JSON.parse(raw);return typeof value.id==='string'&&typeof value.fingerprint==='string'?value as Saved:null;}catch{return null;}},[key]);
 const remember=useCallback((value:Saved|null)=>{memory.current=value;try{if(value)localStorage.setItem(key,JSON.stringify(value));else localStorage.removeItem(key);}catch{}},[key]);
 const fingerprint=async(endpoint:string)=>{const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(endpoint)));return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');};
 const explain=(error:unknown)=>error instanceof ApiError?error.message:text('تعذر إتمام طلب إشعارات الجهاز. لم نؤكد نجاحه؛ حاول مجدداً.','The device notification request failed. Success was not confirmed; try again.');
 const refresh=useCallback(async()=>{
  const current=generation.current;
  if(!user||!capable()){if(current===generation.current){setSupported(false);setChecking(false);}return;}
  setSupported(true);setPermission(Notification.permission);setChecking(true);
  try{const server=await api<Status>('/push/status');const registration=await navigator.serviceWorker.getRegistration('/');const subscription=await registration?.pushManager.getSubscription();
   const saved=readSaved(),matches=!!(subscription&&saved&&saved.fingerprint===await fingerprint(subscription.endpoint)&&server.subscriptions.some(s=>s.id===saved.id));
   if(current!==generation.current)return;setStatus(server);setLocalExists(!!subscription);setActive(matches&&Notification.permission==='granted');setFailure('');
  }catch(error){if(current===generation.current){setStatus(null);setActive(false);setFailure(explain(error));}}
  finally{if(current===generation.current)setChecking(false);}
 },[user?.id,readSaved,text]);
 useEffect(()=>{generation.current++;memory.current=null;setStatus(null);setActive(false);setLocalExists(false);setBusy(false);setNotice('');setFailure('');void refresh();
  const onFocus=()=>{if(!busyRef.current)void refresh();};window.addEventListener('focus',onFocus);
  const onMessage=(event:MessageEvent)=>{if(!busyRef.current&&event.data?.type==='VIP_PUSH_SUBSCRIPTION_CHANGED')void refresh();};
  navigator.serviceWorker?.addEventListener('message',onMessage);
  return()=>{generation.current++;window.removeEventListener('focus',onFocus);navigator.serviceWorker?.removeEventListener('message',onMessage);};
 },[user?.id,refresh]);
 async function registrationReady():Promise<ServiceWorkerRegistration>{
  await navigator.serviceWorker.register('/sw.js',{scope:'/'});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([navigator.serviceWorker.ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SW_TIMEOUT')),10_000);})]);}finally{if(timer)clearTimeout(timer);}
 }
 async function enable(){
  if(busy||!user||!capable())return;setBusy(true);setFailure('');setNotice('');const current=generation.current;
  let created:PushSubscription|null=null;
  try{
   // This call is reached only by a real button click, before any awaited API work.
   const granted=Notification.permission==='granted'?'granted':await Notification.requestPermission();
   if(current!==generation.current)return;setPermission(granted);
   if(granted!=='granted'){setNotice(granted==='denied'?text('الإذن محظور. يمكنك تغييره من إعدادات الموقع في المتصفح.','Permission is blocked. Change it in your browser site settings.'):text('لم تمنح إذن الإشعارات؛ لم يُسجل جهاز جديد.','Notification permission was not granted; no new device was registered.'));return;}
   const response=await api<{publicKey:string}>('/push/key');
   if(!/^[A-Za-z0-9_-]{87}$/.test(response.publicKey))throw new Error('PUSH_KEY');
   const raw=atob(response.publicKey.replace(/-/g,'+').replace(/_/g,'/'));const applicationServerKey=Uint8Array.from(raw,c=>c.charCodeAt(0));
   if(applicationServerKey.length!==65||applicationServerKey[0]!==4)throw new Error('PUSH_KEY');
   const registration=await registrationReady();let subscription=await registration.pushManager.getSubscription();
   if(subscription?.options.applicationServerKey){const previous=new Uint8Array(subscription.options.applicationServerKey);
    if(previous.length!==applicationServerKey.length||previous.some((b,i)=>b!==applicationServerKey[i]))throw new ApiError(text('تغير مفتاح الإشعارات. ألغِ الاشتراك الحالي ثم فعّله مجدداً.','The push key changed. Cancel the current subscription, then enable it again.'),409);
   }
   if(!subscription){subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey});created=subscription;}
   const json=subscription.toJSON();
   if(!json.keys?.p256dh||!json.keys.auth)throw new Error('PUSH_KEYS');
   const saved=await api<{ok:boolean;registered:boolean;subscriptionId:string}>('/push/subscription',{method:'POST',json:{endpoint:subscription.endpoint,keys:{p256dh:json.keys.p256dh,auth:json.keys.auth}}});
   if(saved.ok!==true||saved.registered!==true||!/^[-A-Za-z0-9_]{24,80}$/.test(saved.subscriptionId))throw new Error('PUSH_REGISTER');
   if(current!==generation.current)return;
   remember({id:saved.subscriptionId,fingerprint:await fingerprint(subscription.endpoint)});setActive(true);setLocalExists(true);
   setNotice(text('سُجل هذا الجهاز. ظهور الإشعارات يعتمد على المتصفح والنظام والاتصال؛ لم نؤكد وصول إشعار.','This device was registered. Display depends on your browser, OS and connection; no notification delivery was confirmed.'));
   await refresh();
  }catch(error){
   // A lost HTTP response may mean the server saved it. Do not fake success or
   // automatically retry. A later explicit click can safely refresh the same row.
   // Preserve a newly created browser subscription after an unknown response;
   // unsubscribing here could orphan an already committed server registration.
   if(current===generation.current){if(created)setLocalExists(true);setActive(false);setFailure(explain(error));}
  }finally{if(current===generation.current)setBusy(false);}
 }
 async function cancel(all=false){
  if(busy||!user)return;setBusy(true);setFailure('');setNotice('');const current=generation.current;
  try{const registration=capable()?await navigator.serviceWorker.getRegistration('/'):undefined;
   const subscription=await registration?.pushManager.getSubscription(),saved=readSaved();
   if(!all&&!subscription&&!saved)throw new Error('NO_SUBSCRIPTION');
   const json=all?{all:true}:subscription?{endpoint:subscription.endpoint}:{subscriptionId:saved!.id};
   const result=await api<{ok:boolean;registered:boolean}>('/push/subscription',{method:'DELETE',json});
   if(result.ok!==true||result.registered!==false)throw new Error('PUSH_CANCEL');
   // Server removal first: if browser unsubscribe fails we do not claim a fully
   // removed local subscription, but the server has stopped sending to this row.
   if(subscription){const removed=await subscription.unsubscribe();if(!removed&&await registration!.pushManager.getSubscription())throw new ApiError(text('أوقف الخادم الإرسال، لكن تعذر إلغاء الاشتراك المحلي. حاول الإلغاء مجدداً.','Server sending stopped, but local cancellation failed. Try cancelling again.'),503);}
   if(current!==generation.current)return;remember(null);setActive(false);setLocalExists(false);
   setNotice(text('أُلغي التسجيل. لسحب إذن المتصفح نفسه استخدم إعدادات الموقع؛ لا يستطيع الموقع سحبه نيابةً عنك.','Registration was cancelled. Revoke browser permission in site settings; the website cannot revoke it for you.'));await refresh();
  }catch(error){if(current===generation.current)setFailure(explain(error));}
  finally{if(current===generation.current)setBusy(false);}
 }
 if(!user)return null;
 return <section className="metal-panel" aria-labelledby="vip-push-title">
  <h2 id="vip-push-title">{text('إشعارات الجهاز','Device notifications')}</h2>
  <p>{text('اختيارية بإذنك. تبقى إشعاراتك داخل VIP حتى إذا فشل Push. نغمة VIP المميزة اختيار داخل التطبيق فقط؛ خارج التطبيق يقرر النظام الصوت، وليست إنذار طوارئ أو صوتاً مفروضاً.','Optional, with your permission. VIP notifications remain in the app if push fails. The distinctive VIP tone is an in-app choice only; outside the app the OS controls sound. This is not an emergency alarm or forced audio.')}</p>
  {!supported&&!checking&&<p role="status">{text('إشعارات الجهاز غير مدعومة هنا. قد تتطلب بعض الأجهزة تثبيت VIP على الشاشة الرئيسية.','Device notifications are not supported here. Some devices require installing VIP on the Home Screen.')}</p>}
  {supported&&<>
   <p role="status">{checking?text('جارٍ التحقق…','Checking…'):active&&status?.enabled?text('هذا الجهاز مسجل للإشعارات.','This device is registered for push.'):permission==='denied'?text('الإذن محظور من المتصفح.','Permission is blocked by the browser.'):localExists?text('يوجد اشتراك محلي؛ يلزم تأكيد تسجيله في الخادم.','A local subscription exists; its server registration needs confirmation.'):text('هذا الجهاز غير مسجل.','This device is not registered.')}</p>
   {status&&!status.enabled&&<p>{text('إرسال Push غير مهيأ حالياً؛ يمكنك إلغاء تسجيل أجهزتك.','Push sending is not configured currently; you can cancel device registrations.')}</p>}
   {status&&<p>{text('عدد أجهزتك المسجلة:','Registered devices:')} {status.deviceCount}/{status.maxDevices}</p>}
   <button type="button" className="metal-button" disabled={busy||checking||!status?.enabled||active||permission==='denied'} onClick={()=>void enable()}>{busy?text('جارٍ التنفيذ…','Working…'):text('السماح وتسجيل هذا الجهاز','Allow and register this device')}</button>
  </>}
  {(localExists||active)&&<button type="button" className="text-button" disabled={busy||checking} onClick={()=>void cancel()}>{text('إلغاء إشعارات هذا الجهاز','Cancel push on this device')}</button>}
  {!!status?.deviceCount&&<button type="button" className="text-button" disabled={busy||checking} onClick={()=>void cancel(true)}>{text('إلغاء إشعارات جميع أجهزتي','Cancel push on all my devices')}</button>}
  <button type="button" className="text-button" disabled={busy||checking} onClick={()=>void refresh()}>{text('تحديث الحالة','Refresh status')}</button>
  <p>{text('لتغيير الإذن أو سحبه: إعدادات الموقع في المتصفح ← الإشعارات.','To change or revoke permission: browser site settings → Notifications.')}</p>
  {failure&&<p role="alert">{failure}</p>}{notice&&<p role="status">{notice}</p>}
 </section>;
}
