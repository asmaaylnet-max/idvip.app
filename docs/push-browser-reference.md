# مرجع تشغيل إشعارات الأجهزة

قُرئت وثائق Apple الرسمية [Sending web push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) و[WebKit Meet Web Push](https://webkit.org/blog/12945/meet-web-push/) و[MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) في 7 نوفمبر 2026. تشترط Apple TLS وSNI وعناوين ضمن push.apple.com وتطلب قبولاً بتفاعل المستخدم وعرض كل إشعار. تؤكد MDN أن endpoint عنوان قدرة سري؛ لذلك تخزنه الوحدة مشفراً ولا تعيده في قائمة الأجهزة. الرد201 قبول المزود لا إثبات عرض الجهاز.

هذه مراجع API ولا تمثل اختبار مزود حي أو جهاز، والتمكين الإنتاجي يتطلب مفاتيح VAPID وPUSH_ENABLED ومراجعة الصيغ الفعلية. إشعارات التطبيق تحفظ مستقلة عن محاولة Push؛ الصوت المميز داخل التطبيق فقط، بينما خارج التطبيق تتحكم إعدادات نظام التشغيل. قائمة إرسال كبيرة تتجاوز حد المكملة تستلزم توزيعاً مستديماً قبل ادعاء إرسال جهاز إلى الجميع؛ لا تدّعي هذه النسخة ذلك.

مرجع Mozilla الرسمي https://mozilla-push-service.readthedocs.io/ يؤكد Autopush كخدمة Firefox ويوجّه إلى وثيقة HTTP API. قُرئ مرجع Chrome https://developer.chrome.com/blog/push-notifications-on-the-open-web الذي يعرض fcm.googleapis.com/fcm/send، لكنه مقال2015 يسبق VAPID الحديث؛ لا يعتمد وحده دليلاً على صيغ المتصفح الحالية، ولا تُنفّذ منه تعليمات GCM المندثرة. التمكين الحالي مقيد ولا يشمل endpoint لم تُراجع صيغته الفعلية.
