export class ApiError extends Error { constructor(message:string, public status:number, public code?:string, public details:Record<string,unknown>={}){ super(message); } }
let csrf='';
export function setCSRF(value:string){ csrf=value; }
export async function api<T=any>(path:string, options:RequestInit & {json?:unknown}={}):Promise<T>{
 const {json,...rest}=options;
 const locale=document.documentElement.lang==='en'?'en':'ar';
 const res=await fetch('/api'+path,{ credentials:'include',...rest,headers:{'X-Locale':locale, ...(json!==undefined?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...rest.headers },...(json!==undefined?{body:JSON.stringify(json)}:{}) });
 const raw:unknown=await res.json().catch(()=>({error:locale==='ar'?'تعذر قراءة الاستجابة':'Unable to read response'}));
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ApiError(locale==='ar'?'استجابة غير صالحة':'Invalid response',res.status);
 const data=raw as Record<string,unknown>;
 if(!res.ok) throw new ApiError(typeof data.error==='string'?data.error:(locale==='ar'?'تعذر إتمام الطلب':'Request failed'),res.status,typeof data.code==='string'?data.code:undefined,data);
 if(typeof data.csrf==='string') csrf=data.csrf;
 return data as T;
}
export function download(url:string){ const a=document.createElement('a');a.href=url;a.download='';a.rel='noopener';a.click(); }
