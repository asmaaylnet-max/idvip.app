# عقد API لمنصة VIP

يصدّر `src/server/api.ts` الكائن `apiApp` والنوع `Env`، والدالة `getSession(request: Request, env: Env)` لإعادة استخدام قارئ الجلسة في SSR أو تفويض التصدير. نتيجة الدالة `{user:UserRow,session:SessionRow}|null` خاصة بالخادم؛ لا تُرسل UserRow مباشرة للعميل لأنها تحتوي حقول تخزين المصادقة. يُركّب الأب `apiApp` على `/api`، بينما المسارات داخل التطبيق لا تحتوي هذه البادئة. العينة `test` ومسارات التصدير العامة يقدّمها الأب، لا حسابات مختلقة في قاعدة البيانات.

النتائج JSON، والخطأ `{error,code}`. يستخدم الخادم `locale: 'ar'|'en'` في جسم JSON، ثم `X-Locale`، والعربية افتراضياً. اللغة الصريحة في الجسم تتقدم على الرأس. لا نصوص أخطاء ثنائية اللغة مختلطة. بعض حالات الإرسال تضيف `challengeId` أو `invitationId` إلى خطأ 503 حتى يمكن إعادة المحاولة دون إنشاء رسالة أخرى.

## البيئة

`DB: D1Database`، و`MEDIA?: R2Bucket`، و`SESSION_SECRET` بطول 32 محرفاً على الأقل، و`PUBLIC_ORIGIN`، و`COOKIE_MODE: 'preview'|'production'`، و`RESEND_API_KEY?`، و`RP_ID?`. الإنتاج على `https://idvip.app`. Preview يطابق PUBLIC_ORIGIN ومضيف الطلب تماماً؛ HTTP مسموح فقط لـlocalhost/127.0.0.1 في فحص Origin، لكن cookie تبقى Secure ولا توجد مصادقة تطوير متجاوزة.

البديل الأصلي اختياري بهذا العقد:

```ts
EMAIL?: {
  send(message: {
    from: string; to: string; subject: string;
    html: string; text: string; replyTo: string;
  }): Promise<unknown>;
}
```

على المحول الحقيقي أن يرفض Promise عند عدم قبول المزود للرسالة؛ تحقق Promise يعني قبول الإرسال، لا الوصول للصندوق. لا يُنشئ API هذا الربط ولا يختلق مرسلاً بديلاً. رفض رفع الوسائط وعرضها عند غياب R2 هو 503 مبكر. حذف حساب لا يملك وسائط لا يحتاج R2؛ حساب له وسائط لا يُعلن حذف ملفاته إذا الربط غير متاح.

المرسل والرد والدومين من `BRAND`. بريد OTP بتصميم عربي أو إنجليزي مستقل وصور غلاف وشعار بروابط مطلقة `https://idvip.app/brand/cover-dark.webp` و`logo-dark.webp`، ومن ثم يجب أن يحافظ فريق الأصول على هذه المسارات أو يحدّث المراجع المملوكة للخادم بالتنسيق.

## الجلسة والمصادقة

`GET /session` يعيد `{user:null,csrf:null,site:null}` للزائر، أو `{user,csrf,site}`. بيانات User العامة هي `id,email,name,role,publicId,hasPassword,hasPasskey`.

`GET /availability?slug=` يعيد `{slug,available}`. الاسم DNS صغير الحروف، 1–63 محرفاً، حرف/رقم في الطرفين مع شرطات داخلية. يحظر الخادم مخزون أسماء النظام والحساسة و`xn--`. الحجز UNIQUE مع انتهاء، ولا تكفي نتيجة availability لحجز الاسم؛ الحجز الذري يجري عند طلب التسجيل.

`POST /auth/request` يستقبل:

```json
{
  "email":"user@example.com", "purpose":"signup",
  "name":"Name", "slug":"profile-name", "language":"ar", "locale":"ar",
  "whatsapp":"", "phone":"", "termsAccepted":true, "ageConfirmed":true
}
```

purpose هو signup أو login أو recover. التسجيل الجديد يتطلب الاسم والاسم الفرعي ولغة المحتوى والموافقتين. يمكن دخول الإيميلين الأساسيين لأول مرة عبر OTP دون اختلاق حساب مسبق؛ لا تنشأ صلاحية owner أو principal إلا بعد OTP صحيح. الدعوة تضيف `inviteId`؛ المستفيد الجديد يؤكد الشروط والعمر، ونمط managed يأخذ اسم الملف ولغته من الدعوة.

نجاح الطلب `{challengeId,message,expiresIn:600,resendAfter:60}` يعني قبول المزود للإرسال فقط. الرمز ستة أرقام مولّد بـWeb Crypto، محفوظ HMAC مرتبطاً بالتحدي، صالح 10 دقائق، وله ست محاولات تحقق. إعادة الطلب الجديد لا تقل عن 60 ثانية، مع قفل D1 يمنع الطلبين المتزامنين من تخطي المهلة. توجد حصص منفصلة للبريد وعنوان الاتصال.

عند 503 EMAIL_UNKNOWN مع challengeId، أعد نفس `/auth/request` بالجسم `{email,purpose,challengeId,locale?}`. يعاد نفس محتوى البريد ومفتاح منع التكرار؛ لا رمز جديد. لا تُعاد محاولة مرسل EMAIL ذي قبول مجهول لأنه لا يقدم ضمان idempotency. يمكن استخدام PIN إن وصل فعلاً حتى عندما سجل الإرسال غير مؤكد.

`POST /auth/verify` يستقبل `{challengeId,pin,acceptInvitation?:true,locale?}`. يعيد `{user,csrf,site}` مع جلسة جديدة. تحدي OTP يستهلك مرة واحدة ذرياً. recover يبطل الجلسات القديمة قبل إصدار الجلسة الجديدة.

`POST /auth/password` يستقبل `{password,locale?}`، ويتطلب جلسة وتحققاً حديثاً خلال خمس دقائق. الحد 13–256 محرفاً مع رقم وحرف لاتيني كبير وصغير. PBKDF2-SHA256 بـ100000 دورة، salt عشوائي وHMAC pepper من SESSION_SECRET. لا يمكن تغيير الرمز من مجرد Session قديمة. يبطل حفظ الرمز الجلسات الأخرى.

`POST /auth/login`: `{email,password,locale?}` ويعيد جلسة. `POST /auth/logout`: `{}` مع CSRF، يبطل الجلسة الحالية ويحذف cookie.

Cookie هي `__Host-vip_session`، host-only، HttpOnly، Secure، SameSite=None في Preview وLax في Production، مدة 30 يوماً. المخزن في D1 بصمة الرمز العشوائي لا الرمز نفسه. لا تقبل الهوية من `X-User-Identity` ولا يوجد bypass dev login.

كل تغيير موثّق يحتاج `X-CSRF-Token` وOrigin مسموحاً. المضيفون الموثوقون للإنتاج: الدومين الأساسي وwww/admin/account/auth/login/register تحته، لا مواقع المستأجرين. لا CORS wildcard ولا نقل جلسات بين ملفات المستخدمين. التغييرات غير الموثقة مثل طلب OTP والدخول تتحقق أيضاً من Origin والمضيف.

## مفاتيح المرور

`POST /auth/passkeys/register/options` يستقبل `{}`، يتطلب جلسة وتحققاً حديثاً، ويعيد `{challengeId,options}`. `POST /auth/passkeys/register/verify` يستقبل `{challengeId,response,locale?}` ويعيد `{verified:true}` بعد تحقق SimpleWebAuthn حقيقي.

`POST /auth/passkeys/authentication/options`: `{email?,locale?}`، والغياب يطلب discoverable credential. `POST /auth/passkeys/authentication/verify`: `{challengeId,response,locale?}` ويعيد `{user,csrf,site}`. توجد aliases بنفس العقد تحت `/auth/passkey` المفرد.

RP ID هو idvip.app في الإنتاج، ومضيف Preview في المعاينة. RP_ID الاختياري يجب أن يكون مطابقاً لمضيف موثوق أو أصله المسموح، لا نطاق مستأجر. يتحقق الخادم من الأصل الدقيق المحفوظ وRP والتوقيع وuser verification والعداد وuserHandle إذا قُدم. التحدي صالح خمس دقائق، مرتبط بالجلسة في التسجيل، ويستهلك مرة واحدة في batch مشروط. يطلب التسجيل residentKey وuserVerification required ولا يجمع بصمات حيوية.

## الملف والمراجعة والبحث

`GET /sites/me` يعيد `{site}` أو `{site:null}` للعضو بلا ملف. Site تشمل draft وpublished وrevision وpublishedRevision وpendingReview وvisible وdiscoverable وownerId.

`PUT /sites/me/draft`: `{data:ProfileData,revision,locale?}` يعيد `{site}`. يحفظ النسخة الجديدة ويزيد revision؛ النسخة القديمة تعطي 409 CONFLICT. يتحقق Zod من كل حقل وأطوال النصوص وأعداد المصفوفات والروابط. مراجع صور غير مملوكة للحساب تعطي 403، حتى لو عرف المستخدم معرّفها.

`POST /sites/me/submit`: `{}` يعيد `{reviewId,site}`، ويأخذ لقطة immutable من draft في SQL داخل المعاملة نفسها، مع revision ونوع publish أو edit ولقطة إعدادات الإفصاح. لا يمكن وجود مراجعتين معلقتين لنفس الموقع. يظل المنشور السابق أثناء انتظار طلب التعديل.

`POST /sites/me/visibility`: `{visible?,discoverable?,hidden?:string[],locale?}` يعيد `{site}`. إضافة الإخفاء وسحب الظهور فوريان. إزالة إخفاء تتطلب مراجعة. إعادة ظهور نسخة معتمدة سابقاً مسموحة إذا ليست معلقة/موقوفة؛ لا ظهور بلا published. إذا أخفى المستخدم الموقع أو حقلاً بعد إرسال المراجعة، لا تلغي الموافقة اللاحقة هذا الإخفاء؛ توجد نسخة إفصاح مستقلة ودمج للحقول المخفية الجديدة.

`GET /sites/:slug` يعيد `{profile:{slug,language,data,publicId}}` من نسخة منشورة مرئية فقط. الحقول المخفية تكون قيمتها فارغة أو مصفوفة فارغة، ولا تظهر hidden نفسها ولا المسودة. `GET /search?q=&country=&city=&specialty=` يعيد `{profiles}` حتى 50 نتيجة مرتبة بالاسم الفرعي. المطابقة تتم على حقول ظاهرة في SQL؛ لا مطابقة من bio/اسم/تخصص مخفي ولا مسودة غير معتمدة. المرشحات البلد/المدينة/التخصص تطابق دون حساسية لحالة الحرف، وq يطابق الاسم والتخصص والبلد والمدينة والنبذة والمهارات الظاهرة.

`DELETE /sites/me` يحذف الحساب وملفه، لا مجرد الموقع، ويتطلب تحققاً حديثاً. يُعطَّل الحساب والجلسات والنشر أولاً في batch مسجل، ثم تُحذف وسائط R2 والصفوف التابعة وOTP/outbox/dعوات الحساب. عند فشل R2 تبقى البيانات غير متاحة ويعيد DELETE_PENDING 503 بدلاً من نجاح زائف. التنظيف الدائم قابل لإكماله عبر مسؤول مؤهل؛ لا توجد بنية مهام دورية منشورة.

## الوسائط

`POST /media`: multipart مع `file`، ينتج `{media:{id,url,width,height,bytes}}` وحالة 201، وurl هو `/api/media/:id`. الحد 8 MiB، 8192 لكل ضلع و32 مليون بكسل. صيغة الرفع النهائية WebP فقط. يقرأ العميل JPG/PNG/WebP ويحوّل، ويرفض الخادم JPG/PNG غير المحوّل بـ415 MEDIA_CONVERT لأن هذا Worker لا يملك Image Binding لإعادة الترميز.

يفحص الخادم RIFF/WEBP وطول الملف وVP8/VP8L/VP8X والأبعاد وعدد صورة واحد، ويرفض SVG والمحتوى المتحرك وEXIF/XMP/ICC. هذا تحقق توقيع وبنية وأبعاد، وليس فك ضغط كامل للبكسلات أو كشف برمجيات خبيثة. التخزين R2 خاص ومفتاح عشوائي مرتبط بالمالك، ولا أسماء ملفات العميل ولا object keys عامة.

`GET /media/:id` يسمح للمالك أو للمشرف إذا استُخدم الوسيط في لقطة مراجعة مسموحة، وللعامة فقط عند الإشارة إليه من حقل ظاهر في ملف منشور مرئي. الصور المخفية لا تُكشف بمعرفة ID. جميع استجابات الوسائط no-store لأن الإخفاء الفوري يجب ألا يعتمد على مسح CDN.

## الإدارة

`GET /admin/reviews?status=pending|approve|reject|changes|suspend|all` يعيد `{reviews}` حتى 100. `GET /admin/reviews/:id` يعيد `{review}`. Review تشمل `language` من لغة الموقع بالإضافة للحقول المشتركة: id/siteId/slug/userName/userEmail/whatsapp/revision/kind/status/data/createdAt. البيانات data هي اللقطة immutable، لا المسودة الجديدة.

`POST /admin/reviews/:id/decision`: `{decision:'approve'|'reject'|'changes'|'suspend',note?,locale?}` يعيد `{ok:true,review}`. approve ينشر `reviews.data_json` نفسه، ويحفظ المراجعة والقرار وسجل العملية والإشعار في batch مشروط. لا يلمس draft. reject/changes يبقيان المنشور السابق. suspend يوقف الظهور والاكتشاف. إعادة اتخاذ قرار أو تغير الدور أو الملكية أثناء العملية تعطي 409 بلا حدث نجاح وهمي.

`GET /admin/users?q=` يعيد `{users}` حتى 100. `POST /admin/users/:id/role`: `{role:'principal'|'moderator'|'user',locale?}`، و`DELETE /admin/users/:id` محصوران بـowner وprincipal ويتطلبان تحققاً حديثاً. كلاهما مخول بالحذف وفق القرار الأخير؛ moderators غير مخولين. لا خفض لدور إيميل المالك الأساسي أو المشرف الأساسي عبر endpoint الدور، ولا تعديل ذاتي للدور. تغيير الدور يبطل جلسات المستخدم المستهدف.

`POST /admin/invite`: `{email,role:'principal'|'moderator'|'user',mode:'moderator'|'managed'|'handover',siteId?,name?,slug?,language?,locale?}`. owner/principal فقط مع تحقق حديث. moderator mode لدعوة دور إداري؛ managed/handover يشترطان role=user. managed ينشئ الملف للمستفيد بعد قبول OTP، ولا حساب أو كلمة مرور مشغل مشتركة. handover يحتاج siteId، ويسجل المالك المتوقع؛ نقل الملكية ذري بعد OTP للبريد المقصود وacceptInvitation=true، ويُبطل جلسات المالك السابق ويحوّل الوسائط ويُنهي المراجعة المعلقة السابقة دون تعديل لقطة بياناتها. إذا المستفيد يمتلك ملفاً، لا يستبدله الخادم صامتاً ويعطي تعارضاً.

الدعوة صالحة سبعة أيام؛ النتيجة `{invitationId,message}` مع 201 تعني قبول بريد الدعوة. إذا لم يقبل البريد تُحفظ الدعوة ويعاد 503 مع invitationId. `GET /auth/invitations/:id` يعيد `{invitation:{id,mode,expiresAt}}` بلا بريد أو بيانات اعتماد. `POST /admin/outbox/:id/retry`: `{}` مع تحقق حديث، يعيد نفس رسالة الدعوة المحفوظة خلال نافذة 24 ساعة؛ لا تبديل محتوى أو مفتاح.

`POST /admin/deletions/retry`: `{}`، owner/principal مع تحقق حديث، ينفذ حتى 10 طلبات تنظيف متبقية ويعيد `{ok:true,pending}`. pending العدد الفعلي في D1، ولا يعني نجاح جميع عمليات R2 إذا بقي أكبر من صفر.

## الإعدادات والمدونات والإشعارات والسجل

`GET /settings` و`GET /admin/settings` يعيدان `{homeLocked,platformLocked}`. `PUT /admin/settings`: `{homeLocked,platformLocked,locale?}`. لا middleware قفل شامل يعطل الحقوق أو الإدارة أو التصفح العام الآمن؛ استخدام إشارات القفل في الواجهة مسؤولية الأب.

`GET /blogs` يعيد `{posts}` المنشورة، و`GET /blogs/:slug` يعيد `{post}`. `GET /admin/blogs` يعيد `{posts}` بما في ذلك المسودات. `PUT /admin/blogs/:id`: `{slug,titleAr,titleEn,bodyAr,bodyEn,published,locale?}` ويعيد `{post}`؛ المحتوى نص/Markdown غير موثوق، لا HTML يصرح الخادم بأنه آمن. الواجهة يجب أن تعرضه كنص أو باستخدام renderer مطهّر.

`GET /notifications` يعيد `{notifications}` حتى 100 خاصة بالمستخدم. `POST /notifications/:id/read` أو `/heard` يستقبل `{}`؛ `DELETE /notifications/:id`، و`DELETE /notifications` أو `/notifications/all` لحذف الخاصة بالمستخدم فقط. `POST /admin/notifications`: `{userIds?:string[],publicIds?:number[],all?:boolean,title,body,locale?}` ينشئ إشعارات داخل التطبيق. لا دعم Web Push في هذا التنفيذ ولا ادعاء إرساله.

`GET /admin/audit?action=&actor=&object=&from=&to=&limit=` يعيد `{events}`، الافتراضي 100 والأقصى 200. actor/object مرشحات معرّفات أصلية يحولها الخادم HMAC للمطابقة؛ الناتج لا يكشف البريد أو الهوية الخام. from/to أزمنة Unix بالثواني. `GET /admin/audit/export?format=json|csv` لنوعي root، مع نفس المرشحات، افتراضي 1000 وأقصى 5000؛ JSON `{events}` وCSV UTF-8 يقتبس القيم ويحمي من صيغ جداول البيانات.

السجل سلسلة HMAC على metadata محدودة وprevHash؛ INSERT السجل والتغيير الحساس في المعاملة نفسها وبشرط صلاحية/حالة/نسخة حيّ داخل SQL. triggers تمنع UPDATE/DELETE للسجل وتعديل لقطة المراجعة. لا أسرار أو PIN أو أجسام طلبات أو بريد في أحداثه. هذا لا يدعي مقاومة مالك حساب Cloudflare أو من يملك DB والسر معاً، ولا توجد مرساة تدقيق خارجية.

## البريد وعدم التكرار

Outbox في D1 مشفر AES-GCM، له lease وحالة pending/sending/accepted/unknown/failed وعدّاد محاولات وأثر عدم يقين دائم. Resend يستخدم مفتاحاً ثابتاً `vip-email/{id}` وجسماً ثابتاً. لا تحويل لـEMAIL بعد timeout أو شبكة أو 5xx أو 409 أو أي تاريخ قبول مجهول، حتى إذا أعادت محاولة لاحقة خطأ حصة صريحاً. التحويل مسموح عند غياب Resend منذ البداية، أو رفض معلوم غير مقبول مثل خطأ حصة 429 معروف أو تحقق/مفتاح 400/401/403/422 معروف دون تاريخ عدم يقين.

OTP/outbox والتحديات المنتهية تنظف تنظيفاً محدوداً عند طلبات فعلية؛ لا deployment أو Cron أو Queue أنشأها هذا العمل. نافذة OTP عشرة دقائق ونافذة بريد الدعوة 24 ساعة، ولا تتم إعادة محاولة بعد احتفاظ Resend بمفتاح منع التكرار. البيانات المشفرة مقصورة على هذه الحاجة التشغيلية، ويحذف payload بمجرد قبول الإرسال.

## ما اختُبر والحدود

في 7 نوفمبر 2026 اجتاز `pnpm exec vitest run tests/backend.test.ts` اختبارات backend المحلية. المحول الاختباري يستخدم `node:sqlite` الحقيقي بما فيه UNIQUE/CHECK/JSON1/triggers/rollback، وMocks للبريد وR2 لا مزوداً حقيقياً. شملت الاختبارات OTP مرة واحدة وحد الست محاولات، cookie، CSRF والمضيف، CAS المسودة، ثبات المراجعة وإخفاء متزامن، حجب البحث والوسائط، عدم تكرار Resend، التحويل بعد رفض معلوم، حظر إعادة EMAIL المجهول، قبول handover، تفويض الحذف، append-only وrollback، وخيارات Passkey. `pnpm exec tsc --noEmit` اجتاز عند التسليم.

لا ادعاء اختبار بريد حقيقي إلى المالك أو ceremony Passkey فعلية من جهاز أو Cloudflare D1/R2 بعيد أو حذف من النسخ الاحتياطية. لا ترميز صور خادمي، ولا Web Push، ولا pagination cursor للمجموعات الأكبر من حدود GET المذكورة. النسخ الاحتياطية وحذفها وربط الخدمات والنشر خارج ملكية هذا الجزء. التكامل مع البريد الأصلي يحتاج محولاً حقيقياً من الأب؛ عدم وجوده ليس مشكلة تُخفى برسالة نجاح.

المراجع التقنية التي استند إليها التنفيذ: [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server)، [Resend idempotency لمدة 24 ساعة](https://resend.com/docs/dashboard/emails/idempotency-keys)، [أخطاء Resend](https://resend.com/docs/api-reference/errors)، و[نقاش حد PBKDF2 في workerd والإنتاج](https://github.com/cloudflare/workerd/issues/1346). اختيرت 100000 دورة للتوافق مع سقف Workers المعروف؛ لا يُدّعى أنه يحقق توصية OWASP الأعلى أو أنه بديل عن قياس CPU واختبار بيئة الإنتاج.
