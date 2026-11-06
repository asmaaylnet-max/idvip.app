import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { Award, BookOpen, Briefcase, ContactRound, Download, ExternalLink, FileText, Globe, Heart, Image as ImageIcon, Languages, Link2, Mail, MapPin, MessageCircle, Phone, Play, QrCode, Share2, Sparkles, StickyNote } from 'lucide-react';
import { api, ApiError } from '../api';
import { useUI } from '../components/Context';
import { Busy, ErrorBox } from '../components/UI';
import { demoProfile } from '../../shared/demo';
import { DEFAULT_SOCIALS, socialNames, type Lang, type MediaItem, type ProfileData, type PublicProfile, type Review, type Site, type TimelineItem } from '../../shared/types';
import { buildVCard, emailLink, publicProfileData, safeExternalURL, safeMediaURL, telephoneNumber, visibleField } from '../../shared/profile-output';
import './Profile.css';

type Props = { slug?: string; preview?: boolean; reviewId?: string };
type LoadedProfile = { key: string; profile: PublicProfile };
type ReviewResponse = { review: Review & { language?: Lang }; language?: Lang; site?: Pick<Site, 'language'> };
const networkNames = { linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', x: 'X', youtube: 'YouTube', snapchat: 'Snapchat', tiktok: 'TikTok', telegram: 'Telegram' };

function Section({ title, icon, children, className = '' }: { title: string; icon?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  const { lang } = useUI();
  return <section className={`profile-card ${className}`} aria-labelledby={id}><div className="profile-section-heading" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>{icon}<h2 id={id}>{title}</h2><span aria-hidden="true" /></div>{children}</section>;
}

function Timeline({ items }: { items: TimelineItem[] }) {
  return <ol className="profile-timeline">{items.filter(item => item.title || item.organization || item.start || item.end || item.description).map((item, i) => <li key={i}>
    <div className="profile-timeline-head">{item.title && <h3>{item.title}</h3>}{(item.start || item.end) && <span className="profile-dates">{[item.start, item.end].filter(Boolean).join(' — ')}</span>}</div>
    {item.organization && <p className="profile-organization">{item.organization}</p>}{item.description && <p className="profile-preserve">{item.description}</p>}
  </li>)}</ol>;
}

function ProfileImage({ url, alt, className = '', eager = false }: { url: string; alt: string; className?: string; eager?: boolean }) {
  const { text } = useUI();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const safe = safeMediaURL(url);
  if (!safe || failed) return <div className={`profile-image-unavailable ${className}`} role={alt ? 'img' : undefined} aria-label={alt || undefined}><ImageIcon aria-hidden="true" size={28} /><span>{text('الصورة غير متاحة حالياً', 'Image currently unavailable')}</span></div>;
  return <img className={className} src={safe} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" onError={() => setFailed(true)} />;
}

function Gallery({ items }: { items: MediaItem[] }) {
  const { text } = useUI();
  return <div className="profile-gallery">{items.filter(item => item.url || item.title || item.description).map((item, i) => {
    const url = safeMediaURL(item.url);
    return <figure key={i}>{url ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={text('فتح الصورة: ', 'Open image: ') + item.title}><ProfileImage url={url} alt={item.title} /></a> : <ProfileImage url="" alt={item.title} />}
      <figcaption>{item.title && <h3>{item.title}</h3>}{item.description && <p>{item.description}</p>}</figcaption>
    </figure>;
  })}</div>;
}

function youtubeId(value: string): string {
  const safe = safeExternalURL(value);
  if (!safe) return '';
  const url = new URL(safe), host = url.hostname.toLowerCase();
  let id = '';
  if (host === 'youtu.be') id = url.pathname.split('/')[1] || '';
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') || '' : /^\/(embed|shorts|live)\//.test(url.pathname) ? url.pathname.split('/')[2] || '' : '';
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
}

function MainVideo({ url }: { url: string }) {
  const { text } = useUI();
  const [active, setActive] = useState(false);
  useEffect(() => setActive(false), [url]);
  const id = youtubeId(url), safe = safeExternalURL(url);
  if (!safe) return null;
  return <div className="profile-video">
    {id ? active ? <iframe src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`} title={text('الفيديو الرئيسي', 'Main video')} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /> : <button className="profile-video-activate" type="button" onClick={() => setActive(true)}><span className="profile-play-disc"><Play aria-hidden="true" size={30} /></span><strong>{text('شاهد الفيديو الرئيسي', 'Watch the main video')}</strong><span>{text('يتم تحميل YouTube بعد اختيار التشغيل فقط.', 'YouTube loads only when you choose to play.')}</span></button> : null}
    <a className="profile-video-source" href={safe} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" />{text('فتح الفيديو في مصدره', 'Open the original video')}</a>
  </div>;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function shareURL(url: string, title: string, text: (ar: string, en: string) => string, toast: (message: string) => void) {
  try {
    if (navigator.share) { await navigator.share({ url, title }); toast(text('تمت المشاركة.', 'Shared.')); }
    else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); toast(text('تم نسخ الرابط.', 'Link copied.')); }
    else toast(text('المشاركة والنسخ غير مدعومين هنا. يمكنك نسخ الرابط الظاهر يدوياً.', 'Sharing and copying are unavailable here. Copy the displayed link manually.'));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    toast(text('لم تتم المشاركة أو نسخ الرابط. حاول مرة أخرى.', 'The link was not shared or copied. Please try again.'));
  }
}

function QRCard({ url, title, logo, filename }: { url: string; title: string; logo: string; filename: string }) {
  const { text, toast } = useUI();
  const [image, setImage] = useState<{ source: string; extension: string } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setImage(null);
    setError(false);
    async function generate() {
      try {
        const canvas = document.createElement('canvas');
        await QRCode.toCanvas(canvas, url, { width: 512, margin: 4, errorCorrectionLevel: 'H', color: { dark: '#000000', light: '#ffffff' } });
        const safeLogo = safeMediaURL(logo);
        if (safeLogo) {
          try {
            const mark = new Image();
            mark.crossOrigin = 'anonymous';
            await new Promise<void>((resolve, reject) => { mark.onload = () => resolve(); mark.onerror = () => reject(new Error('logo')); mark.src = safeLogo; });
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const size = Math.floor(canvas.width * 0.13), x = Math.floor((canvas.width - size) / 2), padding = 4;
              ctx.fillStyle = '#fff';
              ctx.fillRect(x - padding, x - padding, size + 2 * padding, size + 2 * padding);
              ctx.drawImage(mark, x, x, size, size);
            }
          } catch { /* The functional QR remains usable if a remote logo does not allow CORS. */ }
        }
        const source = canvas.toDataURL('image/webp', 1);
        if (!cancelled) setImage({ source, extension: source.startsWith('data:image/webp;') ? 'webp' : 'png' });
      } catch { if (!cancelled) setError(true); }
    }
    void generate();
    return () => { cancelled = true; };
  }, [url, logo]);
  return <div className="profile-qr-card"><h3>{title}</h3><div className="profile-qr-frame">{image ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={text('فتح رابط: ', 'Open link: ') + title}><img src={image.source} alt={text('رمز QR: ', 'QR code: ') + title} width="512" height="512" /></a> : <div className="profile-qr-loading" role="status"><QrCode size={36} aria-hidden="true" /><span>{error ? text('تعذر إنشاء الرمز.', 'Unable to generate the code.') : text('جارٍ إنشاء الرمز…', 'Generating the code…')}</span></div>}</div>
    <a className="profile-qr-url" href={url} target="_blank" rel="noopener noreferrer"><bdi dir="ltr">{url}</bdi></a>
    <div className="profile-qr-actions">{image ? <a className="profile-action" href={image.source} download={`${filename}.${image.extension}`}><Download size={16} aria-hidden="true" />{text('تنزيل الرمز', 'Download QR')}</a> : <button className="profile-action" disabled><Download size={16} aria-hidden="true" />{text('تنزيل الرمز', 'Download QR')}</button>}<button className="profile-action" onClick={() => void shareURL(url, title, text, toast)}><Share2 size={16} aria-hidden="true" />{text('مشاركة', 'Share')}</button><a className="profile-action" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" />{text('فتح الرابط', 'Open link')}</a></div>
  </div>;
}

export default function ProfilePage({ slug = 'test', preview = false, reviewId }: Props) {
  const u = useUI();
  const { text } = u;
  const privateView = preview || Boolean(reviewId), isDemo = !privateView && slug === 'test';
  const requestKey = reviewId ? `review:${reviewId}` : preview ? 'preview' : `public:${slug}`;
  const [loaded, setLoaded] = useState<LoadedProfile | null>(null);
  const [failure, setFailure] = useState<{ key: string; status: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState<'profile' | 'ats' | null>(null);
  useEffect(() => {
    if (isDemo) return;
    const controller = new AbortController();
    setLoaded(null);
    setFailure(null);
    async function load() {
      try {
        let profile: PublicProfile;
        const options = { signal: controller.signal, cache: 'no-store' as RequestCache };
        if (reviewId) {
          const response = await api<ReviewResponse>(`/admin/reviews/${encodeURIComponent(reviewId)}`, options);
          profile = { slug: response.review.slug, language: response.review.language ?? response.language ?? response.site?.language ?? 'ar', data: response.review.data };
        } else if (preview) {
          const { site } = await api<{ site: Site }>('/sites/me', options);
          profile = { slug: site.slug, language: site.language, data: site.draft };
        } else {
          const response = await api<{ profile: PublicProfile }>(`/sites/${encodeURIComponent(slug)}`, options);
          profile = response.profile;
        }
        if (!profile || !profile.data || !['ar', 'en'].includes(profile.language)) throw new Error('Invalid profile response');
        if (!controller.signal.aborted) setLoaded({ key: requestKey, profile });
      } catch (error) {
        if (!controller.signal.aborted) setFailure({ key: requestKey, status: error instanceof ApiError ? error.status : 0 });
      }
    }
    void load();
    return () => controller.abort();
  }, [requestKey, isDemo, preview, reviewId, slug, retry]);

  const profile = useMemo<PublicProfile | null>(() => isDemo ? { slug: 'test', language: u.lang, data: demoProfile(u.lang), isDemo: true } : loaded?.key === requestKey ? loaded.profile : null, [isDemo, u.lang, loaded, requestKey]);
  const data = useMemo(() => profile ? publicProfileData(profile.data) : null, [profile]);
  if (!profile || !data) {
    const error = failure?.key === requestKey ? failure.status : null;
    return <main className="vip-profile profile-status" data-theme={u.theme}>{error === null ? <Busy /> : <><ErrorBox error={error === 401 || error === 403 ? text('هذه المعاينة خاصة. يلزم تسجيل الدخول بحساب مخوّل.', 'This preview is private. Sign in with an authorized account.') : error === 404 ? text('هذا الملف غير متاح للنشر العام أو غير موجود.', 'This profile is not publicly available or does not exist.') : text('تعذر تحميل الملف. تحقق من اتصالك ثم حاول مرة أخرى.', 'Unable to load the profile. Check your connection and try again.')} /><button className="profile-action" onClick={() => setRetry(value => value + 1)}>{text('إعادة المحاولة', 'Try again')}</button></>}</main>;
  }
  const siteURL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(profile.slug) ? `https://${profile.slug}.idvip.app` : '';
  const vCardURL = siteURL ? `${siteURL}/api/vcard/${encodeURIComponent(profile.slug)}` : '';
  const logo = safeMediaURL(data.logo) || `/brand/logo-${u.theme}-384.webp`;
  const cover = safeMediaURL(data.cover) || `/brand/cover-${u.theme}-1280.webp`;
  const email = emailLink(data.email), phone = telephoneNumber(data.phone), whatsapp = telephoneNumber(data.whatsapp);
  const canContact = Boolean(data.name || data.email || phone || whatsapp);
  const hasTimeline = (items: TimelineItem[]) => items.some(item => item.title || item.organization || item.start || item.end || item.description);
  const hasMedia = (items: MediaItem[]) => items.some(item => item.url || item.title || item.description);
  const videoLinks = data.videoLinks.filter(item => safeExternalURL(item.url)), outbound = data.links.filter(item => safeExternalURL(item.url));
  const socials = socialNames.flatMap(name => {
    if (!visibleField(data, `socials.${name}`) || !visibleField(data, name)) return [];
    const url = safeExternalURL(data.socials[name] ?? DEFAULT_SOCIALS[name]);
    return url ? [{ name, url }] : [];
  });
  const downloadContact = () => saveBlob(new Blob([buildVCard(data)], { type: 'text/x-vcard;charset=utf-8' }), `${profile.slug}.vcf`);
  async function exportPDF(kind: 'profile' | 'ats') {
    if (privateView || exporting || !profile) return;
    setExporting(kind);
    try {
      const url = `/api/export/${encodeURIComponent(profile.slug)}/${kind === 'profile' ? 'profile' : 'ats'}.pdf?lang=${u.lang}&theme=${u.theme}`;
      const response = await fetch(url, { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/pdf' } });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/pdf')) throw new Error('PDF unavailable');
      const blob = await response.blob();
      if (await blob.slice(0, 5).text() !== '%PDF-') throw new Error('Invalid PDF response');
      saveBlob(blob, `${profile.slug}-${kind}-${u.lang}.pdf`);
      u.toast(text('بدأ تنزيل ملف PDF.', 'PDF download started.'));
    } catch { u.toast(text('تعذر تنزيل PDF. قد تكون خدمة التصدير غير متاحة حالياً.', 'Unable to download PDF. The export service may be unavailable.')); }
    finally { setExporting(null); }
  }
  return <main className="vip-profile" data-theme={u.theme} dir={u.lang === 'ar' ? 'rtl' : 'ltr'} lang={u.lang}>
    {(privateView || isDemo) && <div className="profile-mode" role="note"><Sparkles size={17} aria-hidden="true" /><span>{reviewId ? text('معاينة خاصة للنسخة المرسلة للمراجعة', 'Private preview of the submitted review snapshot') : preview ? text('معاينة مسودتك الخاصة — لم تُنشر هذه النسخة', 'Private draft preview — this version is not published') : text('عينة VIP المتكاملة — بيانات توضيحية وليست اعتماداً لشخص حقيقي', 'Complete VIP demonstration — illustrative data, not a real person’s accreditation')}</span></div>}
    <header className="profile-hero profile-card">
      {visibleField(data, 'cover') && <ProfileImage url={cover} alt="" className="profile-cover" eager />}
      <div className={`profile-identity ${visibleField(data, 'cover') ? 'with-cover' : ''}`}>
        {visibleField(data, 'logo') && <div className="profile-logo-frame"><ProfileImage url={logo} alt={text('شعار الملف', 'Profile logo')} className="profile-logo" eager /></div>}
        <div className="profile-identity-copy" dir={profile.language === 'ar' ? 'rtl' : 'ltr'} lang={profile.language}>{data.name && <h1>{data.name}</h1>}{data.specialty && <p className="profile-specialty">{data.specialty}</p>}{(data.country || data.city) && <p className="profile-location"><MapPin size={17} aria-hidden="true" />{[data.city, data.country].filter(Boolean).join(' · ')}</p>}</div>
      </div>
      {(data.email || data.phone || data.whatsapp || canContact) && <div className="profile-contact">
        {data.email && (email ? <a className="profile-action" href={email}><Mail size={18} aria-hidden="true" /><span><span className="profile-action-label">{text('البريد الإلكتروني', 'Email')}</span><bdi dir="ltr">{data.email}</bdi></span></a> : <span className="profile-contact-value"><Mail size={18} aria-hidden="true" /><bdi dir="ltr">{data.email}</bdi></span>)}
        {data.whatsapp && (whatsapp ? <a className="profile-action" href={`https://wa.me/${whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer"><MessageCircle size={18} aria-hidden="true" /><span><span className="profile-action-label">{text('واتساب', 'WhatsApp')}</span><bdi dir="ltr">{data.whatsapp}</bdi></span></a> : <span className="profile-contact-value"><bdi dir="ltr">{data.whatsapp}</bdi></span>)}
        {data.phone && (phone ? <a className="profile-action" href={`tel:${phone}`}><Phone size={18} aria-hidden="true" /><span><span className="profile-action-label">{text('اتصال', 'Call')}</span><bdi dir="ltr">{data.phone}</bdi></span></a> : <span className="profile-contact-value"><bdi dir="ltr">{data.phone}</bdi></span>)}
        {canContact && <button className="profile-action" onClick={downloadContact} disabled={privateView} aria-describedby={privateView ? 'profile-private-export' : undefined}><ContactRound size={18} aria-hidden="true" />{text('إضافة جهة اتصال', 'Save contact')}</button>}
      </div>}
    </header>
    <div className="profile-content" dir={profile.language === 'ar' ? 'rtl' : 'ltr'} lang={profile.language}>
      {data.bio && <Section title={text('نبذة مهنية', 'Professional summary')} icon={<BookOpen size={21} aria-hidden="true" />}><p className="profile-bio profile-preserve">{data.bio}</p></Section>}
      {hasTimeline(data.experience) && <Section title={text('الخبرة المهنية', 'Experience')} icon={<Briefcase size={21} aria-hidden="true" />}><Timeline items={data.experience} /></Section>}
      {hasTimeline(data.education) && <Section title={text('التعليم', 'Education')} icon={<BookOpen size={21} aria-hidden="true" />}><Timeline items={data.education} /></Section>}
      {hasTimeline(data.training) && <Section title={text('التدريب والتطوير', 'Training & development')} icon={<Sparkles size={21} aria-hidden="true" />}><Timeline items={data.training} /></Section>}
      {data.languages.some(item => item.name) && <Section title={text('اللغات', 'Languages')} icon={<Languages size={21} aria-hidden="true" />}><ul className="profile-languages">{data.languages.map((item, i) => item.name && <li key={i}><div><span>{item.name}</span>{visibleField(data, `languages.${i}.level`) && <bdi dir="ltr">{item.level}%</bdi>}</div>{visibleField(data, `languages.${i}.level`) && <div className="profile-language-track" role="progressbar" aria-label={item.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.level}><span style={{ width: `${item.level}%` }} /></div>}</li>)}</ul></Section>}
      {data.skills.some(Boolean) && <Section title={text('المهارات', 'Skills')} icon={<Sparkles size={21} aria-hidden="true" />}><ul className="profile-tags">{data.skills.filter(Boolean).map((skill, i) => <li key={i}>{skill}</li>)}</ul></Section>}
      {hasTimeline(data.awards) && <Section title={text('الأوسمة والجوائز والدروع', 'Awards & recognition')} icon={<Award size={21} aria-hidden="true" />}><Timeline items={data.awards} /></Section>}
      {hasMedia(data.workSamples) && <Section title={text('نماذج الأعمال', 'Portfolio')} icon={<ImageIcon size={21} aria-hidden="true" />}><Gallery items={data.workSamples} /></Section>}
      {hasMedia(data.proofs) && <Section title={text('عروض وإثباتات المهارة', 'Skill demonstrations & evidence')} icon={<FileText size={21} aria-hidden="true" />}><Gallery items={data.proofs} /></Section>}
      {(safeExternalURL(data.youtube) || videoLinks.length > 0) && <Section title={text('الفيديو', 'Video')} icon={<Play size={21} aria-hidden="true" />}><MainVideo url={data.youtube} />{videoLinks.length > 0 && <div className="profile-resources profile-video-links">{videoLinks.map((item, i) => <a key={i} href={safeExternalURL(item.url)} target="_blank" rel="noopener noreferrer"><span className="profile-resource-number" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span><span><strong>{item.title || text('رابط فيديو', 'Video link')}</strong>{item.description && <span className="profile-resource-description">{item.description}</span>}</span><ExternalLink size={16} aria-hidden="true" /></a>)}</div>}</Section>}
      {outbound.length > 0 && <Section title={text('روابط إضافية', 'Additional links')} icon={<Link2 size={21} aria-hidden="true" />}><div className="profile-resources">{outbound.map((item, i) => <a key={i} href={safeExternalURL(item.url)} target="_blank" rel="noopener noreferrer"><Link2 size={19} aria-hidden="true" /><span><strong>{item.title || text('رابط', 'Link')}</strong>{item.description && <span className="profile-resource-description">{item.description}</span>}</span><ExternalLink size={16} aria-hidden="true" /></a>)}</div></Section>}
      {data.hobbies.some(Boolean) && <Section title={text('الهوايات', 'Interests')} icon={<Heart size={21} aria-hidden="true" />}><ul className="profile-tags">{data.hobbies.filter(Boolean).map((item, i) => <li key={i}>{item}</li>)}</ul></Section>}
      {data.note && <Section title={text('ملاحظة', 'Note')} icon={<StickyNote size={21} aria-hidden="true" />}><p className="profile-preserve">{data.note}</p></Section>}
    </div>
    {socials.length > 0 && <Section title={text('التواصل الاجتماعي', 'Social networks')} icon={<Globe size={21} aria-hidden="true" />}><nav className="profile-socials" aria-label={text('روابط التواصل الاجتماعي', 'Social network links')}>{socials.map(({ name, url }) => <a key={name} href={url} target="_blank" rel="noopener noreferrer"><span className="profile-social-mark" aria-hidden="true">{name === 'youtube' ? <Play size={17} /> : name === 'telegram' || name === 'snapchat' ? <MessageCircle size={17} /> : <Globe size={17} />}</span>{networkNames[name]}<ExternalLink size={13} aria-hidden="true" /></a>)}</nav></Section>}
    <Section title={text('شارك هويتك', 'Share your identity')} icon={<QrCode size={21} aria-hidden="true" />} className="profile-sharing">
      {privateView ? <div className="profile-private-output"><p id="profile-private-export">{text('التصدير ورموز QR والمشاركة العامة غير متاحة للمسودة أو نسخة المراجعة. تُتاح للنسخة المنشورة بعد الموافقة، دون نشر بياناتك الخاصة.', 'Export, QR codes and public sharing are unavailable for drafts and review snapshots. They become available for the approved public version, without exposing private data.')}</p><div className="profile-downloads"><button className="profile-action" disabled><FileText size={18} aria-hidden="true" />{text('تنزيل البروفايل PDF', 'Download profile PDF')}</button><button className="profile-action" disabled><FileText size={18} aria-hidden="true" />{text('تنزيل سيرة ATS', 'Download ATS résumé')}</button></div></div> : <>
        {siteURL && <div className="profile-qr-grid"><QRCard url={siteURL} title={text('رمز الموقع', 'Website QR')} logo={visibleField(data, 'logo') ? logo : ''} filename={`${profile.slug}-site-qr`} /><QRCard url={vCardURL} title={text('رمز جهة الاتصال', 'Contact QR')} logo={visibleField(data, 'logo') ? logo : ''} filename={`${profile.slug}-contact-qr`} /></div>}
        <div className="profile-downloads"><button className="profile-action" onClick={() => void exportPDF('profile')} disabled={Boolean(exporting)}><FileText size={18} aria-hidden="true" />{exporting === 'profile' ? text('جارٍ تجهيز PDF…', 'Preparing PDF…') : text('تنزيل البروفايل PDF', 'Download profile PDF')}</button><button className="profile-action" onClick={() => void exportPDF('ats')} disabled={Boolean(exporting)}><FileText size={18} aria-hidden="true" />{exporting === 'ats' ? text('جارٍ تجهيز ATS…', 'Preparing ATS…') : text('تنزيل سيرة ATS', 'Download ATS résumé')}</button>{siteURL && <button className="profile-action" onClick={() => void shareURL(siteURL, data.name || 'VIP', text, u.toast)}><Share2 size={18} aria-hidden="true" />{text('مشاركة الموقع', 'Share website')}</button>}</div><p className="profile-output-caption">{text('ملفات التصدير وجهة الاتصال تُنشأ من البيانات العامة غير المخفية فقط.', 'Exports and contact details use only visible public data.')}</p>
      </>}
    </Section>
  </main>;
}
