المعمارية صالحة كبداية مقتصدة: مستودع GitHub واحد، وWorker للتطبيق مع Static Assets، وقاعدة D1 مشتركة، وR2 للأصول، ثم مستهلك Queue صغير للأعمال الخلفية وResend للبريد. لا تنشئ تطبيقاً أو Worker أو قاعدة لكل `name.idvip.app`. هذا حكم صلاحية للتصميم، لا تحقق من إعدادات حساب المالك؛ لم يحدث اتصال بحساب أو فحص مستودع أو نشر.

## 1. نطاقات المستأجرين وStatic Assets

استخدم Route من نوع `*.idvip.app/*` مع سجل DNS wildcard مفعّل عليه Cloudflare proxy. Route يحتاج zone نشطة وDNS proxied؛ وهو يدعم wildcard. هذا النمط لا يشمل `idvip.app` نفسه، لذلك اربط الجذر ولوحة التحكم `app.idvip.app` عبر Worker Custom Domains محددة بالاسم. **لا تستخدم `*.idvip.app` مع `custom_domain: true`**: Worker Custom Domains تطابق hostname كاملاً ولا تدعم wildcard، لكنها تنشئ DNS والشهادة للنطاق المحدد. [1] [2]

هذا الفرق لا يعني ضرورة وجود خادم أصل خارجي لمواقع المستأجرين: اجعل Worker يعيد HTML/API أو `env.ASSETS.fetch(request)`، ولا تمرّر الطلب إلى أصل وهمي عبر `fetch(request)`. Routes تُستخدم عادة أمام أصل، لكن توثيق حدود Workers يقترح wildcard route عند الحاجة إلى عدد كبير من النطاقات بدلاً من Custom Domain لكل اسم. احتفظ بالربط الدقيق لـ`app` و`media`، ولا تسمح للتطبيق بتفسيرهما كمستأجرين. [1] [3] [15]

مع zone اسمها `idvip.app`، تقع `name.idvip.app` في مستوى فرعي واحد يغطيه Universal SSL؛ أما `x.name.idvip.app` فهو مستوى أعمق لا يغطيه Universal SSL تلقائياً. لا تقبل إلا اسماً فرعياً واحداً مسجلاً في D1، وردّ بـ404 للأسماء غير المعروفة، حتى لو طابقها wildcard. نطاقات العملاء الخارجية، إن أضيفت لاحقاً، ليست امتداداً تلقائياً لهذه الآلية: Worker Custom Domain يشترط نطاقاً داخل zone في الحساب، لذلك لها onboarding مستقل ولا تدخل MVP. [1] [2]

وزّع واجهة Arabic/English وأصولها في بناء واحد؛ استخدم `lang` و`dir` المناسبين. Static Assets تخدم الملف المطابق افتراضياً دون تشغيل Worker، لذلك فعّل `run_worker_first` للـAPI ولصفحات HTML أو manifest التي تحتاج تحديد المستأجر، أو لجميع الطلبات أولاً إذا كان ضبط المسارات الانتقائية أصعب. بعد التحقق، قدّم الأصول عبر binding. ملفات JS/CSS المشتركة لا تحتاج قراءة D1 لكل طلب. SPA fallback لا يقوم مقام التحقق من المستأجر، ولا يجعل HTML مخصصاً تلقائياً لكل hostname. [3]

توصية تنفيذية للـPWA: ابدأ بلوحة تحكم قابلة للتثبيت على `app.idvip.app`؛ وأضف PWA خاصة بكل موقع عند وجود حاجة فعلية. اجعل Service Worker يخزن الأصول العامة فقط، ولا يخزن استجابات الحساب أو بيانات خاصة. اربط أي cache ديناميكي بالمستأجر واللغة والصلاحية، وأبقِ جلسة لوحة التحكم host-only دون cookie مشتركة على `.idvip.app`.

## 2. D1: قاعدة مشتركة مع قيود فعلية

ابدأ بجداول للمستأجرين والعضويات والمحتوى والأصول والمهام/البريد. اجعل `tenant_id` إلزامياً في الصفوف التابعة، وأدرجه في كل استعلام مصرح به وفي المفاتيح المركبة للعلاقات بين الموارد. اسم الموقع العام يحتاج قيد `UNIQUE` بعد التطبيع، بينما تفرد slug داخل المستأجر يكون على `(tenant_id, slug)`. لا تكتفِ بـ«SELECT ثم INSERT» لحجز الاسم، ولا تثق في `tenant_id` يرسله العميل. هذه إجراءات تصميم للعزل؛ قاعدة مشتركة لا تنفذ عزل المستأجرين نيابة عن التطبيق.

D1 تفرض foreign keys افتراضياً في الاستعلامات والمهاجرات. لا يمكن تحويلها إلى OFF بالطريقة المعتادة داخل العملية؛ `PRAGMA defer_foreign_keys = on` يؤجل فحصها إلى نهاية المعاملة ولا يلغيها. لذلك صمّم foreign keys المركبة بحيث لا يستطيع مورد تابع لمستأجر الإشارة إلى مورد لمستأجر آخر، وتعامل مع أخطاء القيود كتعارض مفهوم للمستخدم. [8]

`DB.batch([...])` معاملة لأوامر SQL مجهزة سلفاً: تُنفذ بالترتيب، وفشل أحدها يلغي المجموعة كلها. استخدمها مثلاً لتحديث المحتوى وإضافة سجل مهمة أو بريد معاً. سلسلة استعلامات يفصل بينها منطق JavaScript، أو Session، ليست معاملة تفاعلية واحدة. كذلك `UPDATE` الذي يغير صفراً من الصفوف ليس بالضرورة خطأ SQL يسبب rollback؛ انقل الشروط الحاسمة إلى SQL والقيود، وتحقق من `meta.changes`، ولا تفترض أن batch وحدها تحل كل سباقات التزامن. [4]

Sessions تمنح sequential consistency، لا ذرية معاملة. `first-unconstrained` قد يبدأ ببيانات ليست الأحدث، و`first-primary` يبدأ من الرئيسي، وbookmark يسمح ببدء جلسة لاحقة عند نسخة لا تسبق القراءة السابقة. دون Sessions تذهب الاستعلامات إلى الرئيسي حتى عند توفر read replication؛ أبقِ MVP على هذا المسار الأبسط، ثم استخدم bookmarks للقراءة بعد الكتابة إن فعلت النسخ لاحقاً. القرارات الحساسة للصلاحيات والحصص لا تعتمد على قراءة غير مضمونة الحداثة. [4]

قاعدة مشتركة ليست اختياراً بلا سقف: الحد الحالي للقاعدة المدفوعة 10 GB مقابل 500 MB على Free، وكل قاعدة تعالج الاستعلامات تسلسلياً، ويمكن أن ترجع `overloaded`. خزّن الملفات في R2، وضع فهارس تبدأ بـ`tenant_id` حيث يناسب نمط الاستعلام، وراقب زمن SQL والازدحام. لا تفرض شظايا أو قاعدة لكل مستأجر اليوم؛ احتفظ بإمكانية توزيع المستأجرين على عدة قواعد عندما تثبت القياسات الحاجة. [9]

## 3. R2: رفع خاص ونشر عام منفصلان

استخدم bucket خاصاً للأصول الأصلية والمسودات وPDF الخاص، وbucket آخر للمشتقات المنشورة عبر `media.idvip.app`. R2 خاص افتراضياً؛ توصيل public custom domain يفتح وصولاً عاماً لمحتويات bucket ما لم تضف حماية مستقلة، وليس ACL خاصاً بكل ملف. النطاق يجب أن يكون zone في الحساب نفسه. اترك `r2.dev` معطلاً؛ هو للاستخدام غير الإنتاجي ولا يلزم لتشغيل custom domain. النطاق العام يتيح الاستفادة من Cloudflare Cache مع ضبط قواعده، ولا تفترض أن كل نوع ملف سيُخزن تلقائياً. [5]

بعد التحقق من العضوية والحصة، يصدر Worker رابط PUT موقّعاً قصير المدة لمفتاح يولده الخادم، مثل `tenant-id/uploads/random-id`. يرفع المتصفح مباشرة إلى S3 endpoint الخاص بـR2 مع إعداد CORS. **Presigned URLs لا تعمل على R2 custom domain**؛ هي bearer tokens قابلة لإعادة الاستخدام حتى انتهاء المدة، وليست روابط أحادية الاستعمال. توقيع `Content-Type` يقيد قيمة الترويسة، لكنه ليس فحصاً لحقيقة الملف أو ضماناً لسلامته. [6]

اعتبر الرفع مرحلة حجر: سجّل `pending` ثم تحقق من الحجم والنوع الفعلي والمحتوى قبل النشر، ولا تستبدل مفتاحاً منشوراً بمفتاح رفع قابل للكتابة. انقل فقط المشتق المقبول إلى bucket العام. استخدم مفاتيح بإصدار جديد عند تحديث المحتوى لتجنب تقديم نسخة cache قديمة. الخاص ينزل عبر GET موقّع أو Worker يتحقق من الصلاحية، لا عبر النطاق العام. CORS ليس آلية تفويض، ولا يجعل تسريب الرابط الموقّع آمناً. [6]

## 4. Queues للمهام، لا لإلغاء حدود الحوسبة

أرسل إلى Queue معرف المهمة و`tenant_id` ومفتاح R2 والإصدار؛ لا ترسل الملف نفسه. حد الرسالة 128 KB. ابدأ بمستهلك واحد وبـbatch صغيرة، وفصل طابور البريد عن الوسائط لاحقاً فقط إن ظهر تنافس فعلي على الموارد أو تأخير غير مقبول. مستهلك Queue ما زال Worker: لديه حد wall-clock يبلغ 15 دقيقة، وCPU افتراضي 30 ثانية يمكن رفعه إلى 5 دقائق على الإعداد المدفوع الملائم، وذاكرة isolate مقدارها 128 MB. `waitUntil()` بعد استجابة HTTP يمتد حتى 30 ثانية فقط، فلا تستخدمه كبديل موثوق للمهام الطويلة. [10] [15]

Queues تضمن at-least-once، فتكرار التسليم ممكن. اجعل `job_id` وإصدار المدخل ثابتين، والمخرجات قابلة لإعادة الإنشاء بلا آثار مكررة. أقرّ الرسالة بـ`ack()` بعد حفظ النتيجة والحالة، واستخدم retry متدرجاً مع حد محاولات وdead-letter queue؛ الافتراضي ثلاث retries، وبعد استنفادها تُحذف الرسالة إن لم تضبط DLQ. لا تقرّ دفعة كاملة قبل اكتمال كل عناصرها. [11] [14]

لا توجد هنا معاملة واحدة تشمل D1 وQueue وR2 أو Resend: احفظ سجل مهمة/بريد معلّقاً مع تغيير البيانات في batch، ثم حاول enqueue بعد commit. إن فشل enqueue، احتفظ بالسجل لإعادة محاولة قابلة للاسترجاع؛ وإن تكرر enqueue، يعالج المستهلك نفس المعرف دون تكرار الأثر. هذا نمط outbox صغير، وليس خدمة إضافية أو نظام microservices.

Cloudflare Browser Rendering، المسمى **Browser Run** في الوثائق الحالية، مناسب لتصدير HTML/CSS إلى PDF، خصوصاً السيرة أو البروفايل العربي والإنجليزي. يدعم `/pdf` عبر Workers binding دون API token إضافي أو عبر REST، ويمكن تمرير HTML بدلاً من زيارة موقع المستخدم. قدّم قالباً مضبوطاً مع الخط العربي و`dir="rtl"`، وانتظر اكتمال الخطوط والمحتوى، ثم خزّن الناتج في R2 الخاص. لا تستخدم HTML أو URL غير موثوقين مع جلسة المتصفح أو أسرار المنصة؛ قيّد الموارد الخارجية. [12]

ابدأ بـQuick Action من داخل المهمة، وتوازٍ منخفض وحد للحصة لكل مستأجر. Free يسمح بعشر دقائق متصفح يومياً فقط؛ المدفوع له حدود طلبات وتوازي وتكلفة استخدام، وليست قدرة غير محدودة. احترم `Retry-After` عند 429، وأغلق browser صراحة في `finally` إن اخترت Browser Sessions بدلاً من Quick Actions. مهلة خمول المتصفح ليست مهلة Queue ولا سقفاً مضموناً لنجاح PDF. وثيقة PDF نفسها تعرض اختلافاً بين وصف مهلة أحد الأمثلة وقيمته؛ لذلك لا تبنِ وعداً زمنياً على هذا المثال. [12] [13]

Browser Run لتوليد PDF من HTML، لا لتحويل فيديو أو OCR ثقيل أو إصلاح PDF مرفوع عشوائي. صغّر الصور إلى أعمال محدودة أو استخدم خدمة تحويل مناسبة عند الحاجة. ترميز فيديو طويل/FFmpeg أو ملفات تتجاوز الذاكرة والوقت تحتاج محرك معالجة ملائماً يُستدعى من المهمة، أو تؤجَّل من MVP؛ وضعها في Queue وحده لا يجعل Workers بيئة حوسبة ثقيلة. [10] [15]

## 5. Resend: إعادة المحاولة دون وعد exactly-once

استخدم عنوان إرسال واحداً من نطاق يملكه المالك ويُتحقق منه لاحقاً في Resend، لا إعداد نطاق بريد لكل مستأجر. عدم تحقق نطاق `from` خطأ إعداد لا تصلحه إعادة المحاولة. احفظ لكل رسالة منطقية `email_job_id` ثابتاً وpayload ثابتاً وحالة ومعرف Resend، وأرسل `Idempotency-Key` نفسه في كل محاولة. Resend يدعم الإرسال الفردي والدفعي ويحفظ المفاتيح **24 ساعة فقط**؛ لا تنشئ مفتاحاً جديداً عند retry. [7] [16]

أعد محاولة أخطاء الشبكة و500/503 بتأخير متدرج مع jitter وحد للمحاولات. في 429 افحص نوع الخطأ: `rate_limit_exceeded` يحتاج إبطاء ومراعاة الترويسات، بينما الحصة اليومية تنتظر إعادة الضبط عند منتصف الليل UTC، والحصة الشهرية ليست عثرة لحظية. لا تكرر 400/401/403/422 دون إصلاح الطلب أو الإعداد. `409 concurrent_idempotent_requests` قابل للمحاولة لاحقاً؛ `409 invalid_idempotent_request` يعني تغيير payload مع المفتاح نفسه ولا يعالج بالتكرار الأعمى. [7] [16]

اجعل نافذة المحاولات الآلية أقصر من 24 ساعة. إذا انتهت النافذة وكان إرسال سابق غير معلوم النتيجة، لا تعاود الإرسال تلقائياً بوعد منع التكرار؛ انقل الحالة للمراجعة/التسوية. سجل `sent` في D1 وحده لا يلغي احتمال تعطل المستهلك بعد قبول Resend للرسالة وقبل تحديث D1؛ لذلك تحتاج المفتاح الثابت وحالة الاسترجاع معاً. قبول API للرسالة ليس إثباتاً لوصولها لصندوق المستلم. [7]

بهذا يبقى الإصدار الأول تطبيقاً واحداً قابلاً للتوسع، دون Workers for Platforms أو قواعد لكل مستأجر أو محرك وسائط كبير قبل الحاجة. يقتصر التحضير الآن على تصميم schema والقيود ومسارات hostname وحالات المهمة وسياسة الملفات؛ أما الموارد والأسرار وDNS والنشر فتنتظر إذناً مستقلاً.

## References

[1]: https://developers.cloudflare.com/workers/configuration/routing/routes/ "Cloudflare Workers Routes"
[2]: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ "Cloudflare Workers Custom Domains"
[3]: https://developers.cloudflare.com/workers/static-assets/ "Cloudflare Workers Static Assets"
[4]: https://developers.cloudflare.com/d1/worker-api/d1-database/ "Cloudflare D1 Database API: batch and Sessions"
[5]: https://developers.cloudflare.com/r2/buckets/public-buckets/ "Cloudflare R2 Public Buckets"
[6]: https://developers.cloudflare.com/r2/api/s3/presigned-urls/ "Cloudflare R2 Presigned URLs"
[7]: https://resend.com/docs/dashboard/emails/idempotency-keys "Resend Idempotency Keys"
[8]: https://developers.cloudflare.com/d1/sql-api/foreign-keys/ "Cloudflare D1 Foreign Key Constraints"
[9]: https://developers.cloudflare.com/d1/platform/limits/ "Cloudflare D1 Limits"
[10]: https://developers.cloudflare.com/queues/platform/limits/ "Cloudflare Queues Limits"
[11]: https://developers.cloudflare.com/queues/configuration/batching-retries/ "Cloudflare Queues Batching Retries and Delays"
[12]: https://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/ "Cloudflare Browser Run Render PDF"
[13]: https://developers.cloudflare.com/browser-run/limits/ "Cloudflare Browser Run Limits"
[14]: https://developers.cloudflare.com/queues/reference/delivery-guarantees/ "Cloudflare Queues Delivery Guarantees"
[15]: https://developers.cloudflare.com/workers/platform/limits/ "Cloudflare Workers Limits"
[16]: https://resend.com/docs/api-reference/errors "Resend API Errors"
