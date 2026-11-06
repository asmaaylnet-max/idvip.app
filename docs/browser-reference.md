# مراجع المتصفح التي قُرئت في 6 نوفمبر 2026

- https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event — دعم محدود، لا موعد مضمون للحدث. يمكن تصميم دعوة داخلية لكن نافذة النظام بعد الضغط وعند دعم الحدث فقط.
- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ — إشعارات الويب لتطبيقات الشاشة الرئيسية من iOS/iPadOS 16.4. الإذن نتيجة تفاعل مباشر، نظام التركيز والصلاحيات بيد المستخدم. متصفحات الطرف الثالث تستطيع عرض إضافة للشاشة الرئيسية وفق شروط المنصة؛ لا يصح حصر التثبيت في Safari على كل الإصدارات.
- https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition — دعم غير شامل. بعض المتصفحات ترسل الصوت لخدمة خارجية. processLocally وavailable وinstall تحتاج كشف القدرات واللغات الفعلي. لا ضمان لتعرف عربي محلي شامل.
- https://www.w3.org/TR/webauthn-2/ — فصل rpId عن origin وتحقق السياق الآمن. لا إتاحة مفاتيح المصادقة الخاصة لسكريبت الموقع. استخدام passkeys لمصادقة الجهاز لا جمع البصمة أو الوجه من المنصة.

الملاحظات أعلاه ليست فحصاً لأجهزة المشروع أو نتائج اختبار المنصة؛ هي حدود المراجع الرسمية للبنية المقترحة.

- https://web.dev/articles/vitals — قُرئ المصدر الرسمي: LCP <= 2.5s وINP <= 200ms وCLS <= 0.1 عند المئين 75، والقياس المعملي لا يغني عن الميداني.

- https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/scope — قُرئ المصدر الرسمي: نطاق manifest يحدد سياق التطبيق، والتنقل خارج النطاق مسموح لكنه قد يعرض واجهة متصفح أو سياقاً علوياً مختلفاً. لا يفترض دعم شامل لانتقال تطبيق مستقل واحد بين جميع النطاقات الفرعية.

## تأكيد Quick Actions — 7 نوفمبر 2026

قُرئت المصادر الرسمية https://developers.cloudflare.com/browser-run/get-started/ وhttps://developers.cloudflare.com/browser-run/quick-actions/ وhttps://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/ . BROWSER.quickAction("pdf", {html,...}) طريقة فعلية تعيد Response؛ تتطلب compatibility_date>=2026-03-24، والمشروع يستخدم 2026-11-06. لا مفتاح API في Worker لهذا الاتصال. لا تعمل quickAction في محاكاة Wrangler المحلية؛ تحتاج remote Browser binding أو wrangler dev --remote. لهذا لا تعد Preview المحلية إثبات PDF حي.
