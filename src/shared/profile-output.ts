import { EMPTY_PROFILE, socialNames, type Lang, type ProfileData, type Theme, type TimelineItem } from './types';

/** These helpers do not authorize access. The caller must supply an approved public snapshot. */
export function escapeHTML(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function safeExternalURL(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value.trim())) return '';
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

/** Only root-relative application assets or explicit HTTP(S) resources. Never data: or javascript:. */
export function safeMediaURL(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (/^\/(?!\/)/.test(url) && !/[\u0000-\u0020\u007f\\]/.test(url)) return url;
  return safeExternalURL(url);
}

export function visibleField(data: Pick<ProfileData, 'hidden'>, key: string): boolean {
  return !(data.hidden ?? []).some(hidden => key === hidden || key.startsWith(hidden + '.'));
}

/** Defense in depth for public rendering. Do not use this to turn a draft into a public snapshot. */
export function publicProfileData(data: ProfileData): ProfileData {
  const result: ProfileData = { ...EMPTY_PROFILE, socials: {}, hidden: [...(data.hidden ?? [])] };
  const textFields = ['name', 'email', 'whatsapp', 'phone', 'specialty', 'country', 'city', 'bio', 'note', 'youtube', 'logo', 'cover'] as const;
  for (const key of textFields) result[key] = visibleField(data, key) && typeof data[key] === 'string' ? data[key] : '';
  const timelineFields = ['experience', 'education', 'training', 'awards'] as const;
  for (const key of timelineFields) result[key] = visibleField(data, key) && Array.isArray(data[key])
    ? data[key].map((item, i) => ({
      title: visibleField(data, `${key}.${i}.title`) ? item.title : '',
      organization: visibleField(data, `${key}.${i}.organization`) ? item.organization : '',
      start: visibleField(data, `${key}.${i}.start`) ? item.start : '',
      end: visibleField(data, `${key}.${i}.end`) ? item.end : '',
      description: visibleField(data, `${key}.${i}.description`) ? item.description : '',
    })) : [];
  for (const key of ['skills', 'hobbies'] as const) result[key] = visibleField(data, key) && Array.isArray(data[key])
    ? data[key].map((item, i) => typeof item === 'string' && visibleField(data, `${key}.${i}`) ? item : '') : [];
  result.languages = visibleField(data, 'languages') && Array.isArray(data.languages)
    ? data.languages.map((item, i) => ({ name: visibleField(data, `languages.${i}.name`) ? item.name : '', level: visibleField(data, `languages.${i}.level`) ? Math.max(0, Math.min(100, Number(item.level) || 0)) : 0 })) : [];
  for (const key of ['workSamples', 'proofs'] as const) {
    result[key] = visibleField(data, key) && Array.isArray(data[key])
      ? data[key].map((item, i) => ({ title: visibleField(data, `${key}.${i}.title`) ? item.title : '', url: visibleField(data, `${key}.${i}.url`) ? item.url : '', description: visibleField(data, `${key}.${i}.description`) ? item.description : '' })) : [];
  }
  for (const key of ['videoLinks', 'links'] as const) {
    result[key] = visibleField(data, key) && Array.isArray(data[key])
      ? data[key].map((item, i) => ({ title: visibleField(data, `${key}.${i}.title`) ? item.title : '', url: visibleField(data, `${key}.${i}.url`) ? item.url : '', description: visibleField(data, `${key}.${i}.description`) ? item.description : '' })) : [];
  }
  for (const name of socialNames) if (visibleField(data, `socials.${name}`) && visibleField(data, name)) {
    const url = data.socials?.[name];
    if (typeof url === 'string') result.socials[name] = url;
  }
  return result;
}

export function emailLink(email: string): string {
  const value = email.trim();
  return /^[^\s@<>;,?]+@[^\s@<>;,?]+\.[^\s@<>;,?]+$/.test(value) ? `mailto:${encodeURIComponent(value).replace(/%40/g, '@')}` : '';
}

export function telephoneNumber(value: string): string {
  const text = value.trim();
  if (!/^[+\d\s().-]{3,32}$/.test(text)) return '';
  const digits = text.replace(/\D/g, '');
  return digits ? (text.startsWith('+') ? '+' : '') + digits : '';
}

function vCardText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Fold UTF-8 lines at 75 octets without splitting Arabic or surrogate pairs (RFC 6350). */
function foldVCardLine(line: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let part = '', bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) { lines.push(part); part = ' '; bytes = 1; }
    part += character;
    bytes += size;
  }
  lines.push(part);
  return lines.join('\r\n');
}

export function buildVCard(input: ProfileData, websiteURL=''): string {
  const data = publicProfileData(input);
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vCardText(data.name)}`];
  if (data.specialty) lines.push(`TITLE:${vCardText(data.specialty)}`);
  if (emailLink(data.email)) lines.push(`EMAIL;TYPE=INTERNET:${vCardText(data.email.trim())}`);
  const phone = telephoneNumber(data.phone), whatsapp = telephoneNumber(data.whatsapp);
  if (phone) lines.push(`TEL;TYPE=VOICE:${phone}`);
  if (whatsapp && whatsapp !== phone) lines.push(`TEL;TYPE=CELL:${whatsapp}`);
  if (data.city || data.country) lines.push(`ADR;TYPE=WORK:;;;${vCardText(data.city)};;;${vCardText(data.country)}`);
  const note = [data.bio, data.note].filter(Boolean).join('\n\n');
  if (note) lines.push(`NOTE:${vCardText(note)}`);
  const urls = new Set([safeExternalURL(websiteURL),...data.links.map(item => safeExternalURL(item.url)), ...socialNames.map(name => safeExternalURL(data.socials[name]))].filter(Boolean));
  for (const url of urls) lines.push(`URL:${vCardText(url)}`);
  lines.push('END:VCARD');
  return lines.map(foldVCardLine).join('\r\n') + '\r\n';
}

const labels = {
  ar: { profile: 'الملف المهني', ats: 'السيرة الذاتية', contact: 'التواصل', bio: 'نبذة مهنية', experience: 'الخبرة المهنية', education: 'التعليم', training: 'التدريب والتطوير', languages: 'اللغات', skills: 'المهارات', awards: 'الأوسمة والجوائز والدروع', hobbies: 'الهوايات', note: 'ملاحظة', workSamples: 'نماذج الأعمال', proofs: 'عروض وإثباتات المهارة', videos: 'روابط الفيديو', mainVideo: 'الفيديو الرئيسي', links: 'روابط إضافية', socials: 'التواصل الاجتماعي', email: 'البريد الإلكتروني', phone: 'الهاتف', whatsapp: 'واتساب', location: 'الموقع', specialty: 'التخصص' },
  en: { profile: 'Professional profile', ats: 'Curriculum vitae', contact: 'Contact', bio: 'Professional summary', experience: 'Experience', education: 'Education', training: 'Training & development', languages: 'Languages', skills: 'Skills', awards: 'Awards & recognition', hobbies: 'Interests', note: 'Note', workSamples: 'Portfolio', proofs: 'Skill demonstrations & evidence', videos: 'Video links', mainVideo: 'Main video', links: 'Additional links', socials: 'Social networks', email: 'Email', phone: 'Phone', whatsapp: 'WhatsApp', location: 'Location', specialty: 'Specialty' },
};
const networkTitles = { linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', x: 'X', youtube: 'YouTube', snapchat: 'Snapchat', tiktok: 'TikTok', telegram: 'Telegram' };

export function renderProfileDocument(input: ProfileData, lang: Lang, theme: Theme, kind: 'profile' | 'ats'): string {
  const data = publicProfileData(input), t = labels[lang], ats = kind === 'ats', h = escapeHTML;
  const absoluteMedia = (url: string) => { const safe = safeMediaURL(url); return safe ? new URL(safe, 'https://idvip.app').href : ''; };
  const link = (url: string, title: string) => {
    const safe = safeExternalURL(url);
    return safe ? `<a href="${h(safe)}" rel="noopener noreferrer">${h(title || safe)}</a>` : '';
  };
  const section = (title: string, body: string) => body ? `<section><h2>${h(title)}</h2>${body}</section>` : '';
  const paragraph = (text: string) => text ? `<p class="preserve">${h(text)}</p>` : '';
  const timeline = (items: TimelineItem[]) => items.filter(item => item.title || item.organization || item.description || item.start || item.end).map(item => `<article class="timeline-item"><div class="item-head"><h3>${h(item.title)}</h3>${item.start || item.end ? `<span class="dates">${h([item.start, item.end].filter(Boolean).join(' — '))}</span>` : ''}</div>${item.organization ? `<p class="organization">${h(item.organization)}</p>` : ''}${paragraph(item.description)}</article>`).join('');
  const tags = (items: string[]) => items.filter(Boolean).map(item => `<span class="tag">${h(item)}</span>`).join('');
  const resourceLinks = (items: ProfileData['links']) => items.map(item => {
    const anchor = link(item.url, item.title);
    return anchor ? `<li>${anchor}${item.description ? `<p>${h(item.description)}</p>` : ''}${ats ? `<span class="resource-url" dir="ltr">${h(safeExternalURL(item.url))}</span>` : ''}</li>` : '';
  }).join('');
  const media = (items: ProfileData['workSamples']) => items.map(item => {
    const url = absoluteMedia(item.url);
    if (!url && !item.title && !item.description) return '';
    return `<figure>${!ats && url ? `<img src="${h(url)}" alt="${h(item.title)}" />` : ''}<figcaption>${item.title ? `<h3>${h(item.title)}</h3>` : ''}${paragraph(item.description)}${url ? link(url, ats ? url : item.title || url) : ''}</figcaption></figure>`;
  }).join('');
  const contacts = [
    data.email ? `<div><span>${h(t.email)}</span><bdi dir="ltr">${emailLink(data.email) ? `<a href="${h(emailLink(data.email))}">${h(data.email)}</a>` : h(data.email)}</bdi></div>` : '',
    data.phone ? `<div><span>${h(t.phone)}</span><bdi dir="ltr">${telephoneNumber(data.phone) ? `<a href="tel:${h(telephoneNumber(data.phone))}">${h(data.phone)}</a>` : h(data.phone)}</bdi></div>` : '',
    data.whatsapp ? `<div><span>${h(t.whatsapp)}</span><bdi dir="ltr">${telephoneNumber(data.whatsapp) ? link(`https://wa.me/${telephoneNumber(data.whatsapp).replace(/\D/g, '')}`, data.whatsapp) : h(data.whatsapp)}</bdi></div>` : '',
  ].filter(Boolean).join('');
  const logo = absoluteMedia(data.logo || `/brand/logo-${theme}-384.webp`), cover = absoluteMedia(data.cover || `/brand/cover-${theme}-1280.webp`);
  const branding = !ats ? `${visibleField(data, 'cover') ? `<img class="document-cover" src="${h(cover)}" alt="" />` : ''}${visibleField(data, 'logo') ? `<img class="document-logo" src="${h(logo)}" alt="" />` : ''}` : '';
  const location = [data.city, data.country].filter(Boolean).join(' · ');
  const languageBody = data.languages.map((item, i) => item.name ? `<li><span>${h(item.name)}</span>${visibleField(data, `languages.${i}.level`) ? `<bdi dir="ltr">${item.level}%</bdi>${!ats ? `<div class="language-meter"><span style="width:${item.level}%"></span></div>` : ''}` : ''}</li>` : '').join('');
  const socialBody = socialNames.map(name => {
    const anchor = link(data.socials[name] || '', networkTitles[name]);
    return anchor ? `<li>${anchor}${ats ? `<span class="resource-url" dir="ltr">${h(safeExternalURL(data.socials[name]))}</span>` : ''}</li>` : '';
  }).join('');
  const youtube = link(data.youtube, t.mainVideo);
  const workBody = media(data.workSamples), proofBody = media(data.proofs);
  const videoBody = resourceLinks(data.videoLinks), outboundBody = resourceLinks(data.links);
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${h(data.name ? `${data.name} — ${ats ? t.ats : t.profile}` : ats ? t.ats : t.profile)}</title><style>
@font-face{font-family:Tajawal;src:url('https://idvip.app/fonts/tajawal-arabic-400-normal.woff2') format('woff2');font-weight:400;unicode-range:U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF}
@font-face{font-family:Tajawal;src:url('https://idvip.app/fonts/tajawal-latin-400-normal.woff2') format('woff2');font-weight:400}
@font-face{font-family:Tajawal;src:url('https://idvip.app/fonts/tajawal-arabic-700-normal.woff2') format('woff2');font-weight:700;unicode-range:U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF}
@font-face{font-family:Tajawal;src:url('https://idvip.app/fonts/tajawal-latin-700-normal.woff2') format('woff2');font-weight:700}
@page{size:A4;margin:15mm 14mm 17mm}*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;font:11pt/1.65 Tajawal,Arial,sans-serif;background:var(--paper);color:var(--ink)}
body.profile.dark{--paper:#151413;--ink:#f8f0df;--muted:#c9bfae;--accent:#dec58c;--line:#66563c;--card:#201d19}
body.profile.light{--paper:#fcfaf6;--ink:#29262e;--muted:#625e6a;--accent:#675533;--line:#c6bdac;--card:#f1edef}
body.ats{--paper:#fff;--ink:#181818;--muted:#454545;--accent:#333;--line:#888;--card:#fff}
body.ats.dark{--paper:#151413;--ink:#f3eee3;--muted:#d1c9b9;--accent:#f3eee3;--line:#887d67;--card:#151413}
main{max-width:182mm;margin:auto}
header{position:relative;margin-bottom:8mm;padding-bottom:6mm;border-bottom:1px solid var(--line)}
h1,h2,h3,p,figure{margin:0}
h1{font-size:25pt;line-height:1.3;overflow-wrap:anywhere}
h2{font-size:15pt;line-height:1.4;margin-bottom:3mm;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:1.5mm;break-after:avoid}
h3{font-size:12pt;line-height:1.5;break-after:avoid}p{margin-top:1.5mm;orphans:3;widows:3}a{color:var(--accent);text-decoration:underline;overflow-wrap:anywhere}
.subtitle{font-size:14pt;color:var(--accent);margin-top:2mm}
.location,.organization,.dates{color:var(--muted)}section{margin-bottom:6mm}article,figure,li{break-inside:avoid}
.timeline-item{padding:2mm 0 3mm;border-bottom:1px solid var(--line)}
.item-head{display:flex;justify-content:space-between;gap:4mm;align-items:baseline}
.dates{font-size:10pt;flex-shrink:0}
.preserve{white-space:pre-wrap;overflow-wrap:anywhere}
.tag{display:inline-block;border:1px solid var(--line);padding:.7mm 2.5mm;margin:1mm;background:var(--card)}
.contacts{display:flex;gap:3mm 6mm;flex-wrap:wrap;margin-top:4mm}
.contacts>div{display:flex;gap:2mm;align-items:baseline}
.contacts span{color:var(--muted);font-size:10pt}
.document-cover{width:100%;height:43mm;object-fit:cover;display:block;margin-bottom:26mm;border:1px solid var(--line)}
.document-logo{position:absolute;inset-inline-start:5mm;top:calc(43mm - 10mm);width:30mm;height:30mm;object-fit:cover;border:1.2mm solid var(--paper);border-radius:4mm}
.document-logo:not(.document-cover + .document-logo){position:static;margin-bottom:4mm}
ul{padding-inline-start:5mm;margin:0}
li{margin-bottom:2mm}
.language-list{list-style:none;padding:0}
.language-list li>span{display:inline-block;min-width:28mm}
.language-list bdi{float:inline-end}
.language-meter{height:2mm;background:var(--line);margin-top:1mm}
.language-meter>span{display:block;height:100%;background:var(--accent)}
.media-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm}
figure{border:1px solid var(--line);padding:2mm}
figure img{width:100%;height:33mm;object-fit:contain;background:var(--card)}
figcaption h3{font-size:11pt}
figcaption p{font-size:10pt}
.resource-url{display:block;font-size:9pt;overflow-wrap:anywhere;color:var(--muted)}
.ats header{padding-bottom:4mm}
.ats h1{font-size:20pt}
.ats h2{font-size:13pt}
.ats .item-head{display:block}
.ats .dates{display:block}
.ats .tag{border:0;padding:0;margin:0 0 0 3mm;background:none}
.ats .tag:not(:last-child):after{content:' · ';margin-inline-start:2mm}
.ats .media-grid{display:block}
.ats figure{border:0;padding:0;margin-bottom:3mm}
.ats .contacts{display:block}
.ats .contacts>div{margin-top:1mm}
.ats section{margin-bottom:5mm}
@media screen{body{padding:12mm}
main{padding:8mm;background:var(--paper);box-shadow:0 4px 24px #0002}}
@media print{a{text-decoration:none}
main{max-width:none}body{padding:0}
.document-cover{break-inside:avoid}
.resource-url{font-size:9pt}}
</style></head><body class="${kind} ${theme}"><main><header>${branding}${data.name ? `<h1>${h(data.name)}</h1>` : ''}${data.specialty ? `<p class="subtitle">${h(data.specialty)}</p>` : ''}${location ? `<p class="location">${h(location)}</p>` : ''}${contacts ? `<div class="contacts">${contacts}</div>` : ''}</header>
${section(t.bio, paragraph(data.bio))}
${section(t.experience, timeline(data.experience))}
${section(t.education, timeline(data.education))}
${section(t.training, timeline(data.training))}
${section(t.languages, languageBody ? `<ul class="language-list">${languageBody}</ul>` : '')}
${section(t.skills, tags(data.skills))}
${section(t.awards, timeline(data.awards))}
${!ats?section(t.hobbies, tags(data.hobbies)):''}
${!ats?section(t.workSamples, workBody ? `<div class="media-grid">${workBody}</div>` : ''):''}
${!ats?section(t.proofs, proofBody ? `<div class="media-grid">${proofBody}</div>` : ''):''}
${!ats?section(t.videos, youtube + (videoBody ? `<ul>${videoBody}</ul>` : '')):''}
${!ats?section(t.links, outboundBody ? `<ul>${outboundBody}</ul>` : ''):''}
${ats?section('LinkedIn',link(data.socials.linkedin||'','LinkedIn')):section(t.socials, socialBody ? `<ul>${socialBody}</ul>` : '')}
${!ats?section(t.note, paragraph(data.note)):''}
</main></body></html>`;
}
