export type Lang = 'ar' | 'en';
export type Theme = 'dark' | 'light';
export type Role = 'owner' | 'principal' | 'moderator' | 'user';
export interface User { id: string; email: string; name: string; role: Role; publicId: number; hasPassword?: boolean; hasPasskey?: boolean; }
export interface TimelineItem { title: string; organization: string; start: string; end: string; description: string; }
export interface LanguageItem { name: string; level: number; }
export interface MediaItem { url: string; title: string; description: string; }
export interface LinkItem { title: string; url: string; description?: string; }
export const socialNames = ['linkedin','facebook','instagram','x','youtube','snapchat','tiktok','telegram'] as const;
export type SocialName = typeof socialNames[number];
export interface ProfileData {
  name: string; email: string; whatsapp: string; phone: string; specialty: string; country: string; city: string; bio: string;
  experience: TimelineItem[]; education: TimelineItem[]; training: TimelineItem[]; languages: LanguageItem[];
  skills: string[]; awards: TimelineItem[]; hobbies: string[]; note: string;
  workSamples: MediaItem[]; proofs: MediaItem[]; youtube: string; videoLinks: LinkItem[]; links: LinkItem[];
  socials: Partial<Record<SocialName,string>>; logo: string; cover: string; hidden: string[];
}
export interface Site {
  id: string; slug: string; language: Lang; status: 'draft'|'review'|'published'|'suspended'|'hidden';
  draft: ProfileData; published: ProfileData | null; revision: number; publishedRevision: number | null;
  discoverable: boolean; visible: boolean; ownerId: string; pendingReview?: string | null; privacyHidden?: string[];
}
export interface PublicProfile { slug: string; language: Lang; data: ProfileData; publicId?: number; isDemo?: boolean; }
export interface Notification { id: string; title: string; body: string; createdAt: string; read: boolean; heard: boolean; type?: 'normal'|'special'; }
export interface Review { id: string; siteId: string; slug: string; userName: string; userEmail: string; whatsapp: string; revision: number; kind:'publish'|'edit'; status:string; data:ProfileData; createdAt:string; }
export interface AuditEvent { id: string; actor: string; action: string; object: string; outcome: string; createdAt: string; hash: string; }
export interface BlogPost { id: string; slug: string; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; published: boolean; }
export interface AppSettings { homeLocked:boolean; platformLocked:boolean; }
export interface APIError { error: string; code?: string; }
export const DEFAULT_SOCIALS: Record<SocialName,string> = {
  linkedin:'https://www.linkedin.com/', facebook:'https://www.facebook.com/', instagram:'https://www.instagram.com/',
  x:'https://x.com/', youtube:'https://www.youtube.com/', snapchat:'https://www.snapchat.com/', tiktok:'https://www.tiktok.com/', telegram:'https://telegram.org/'
};
export const EMPTY_PROFILE: ProfileData = { name:'',email:'',whatsapp:'',phone:'',specialty:'',country:'',city:'',bio:'',experience:[],education:[],training:[],languages:[],skills:[],awards:[],hobbies:[],note:'',workSamples:[],proofs:[],youtube:'',videoLinks:[],links:[],socials:{...DEFAULT_SOCIALS},logo:'',cover:'',hidden:[] };
export const BRAND = { domain:'idvip.app', sender:'VIP Support <support@idvip.app>', support:'ceo@idvip.app', whatsapp:'966555444959', owners:['rijalalwatan.com@gmail.com','idvip.app@gmail.com'], socials:DEFAULT_SOCIALS };
