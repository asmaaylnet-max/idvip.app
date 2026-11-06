# أدلة إصلاح الحساب والإدارة — 7 نوفمبر 2026

## الملفات المعدلة

- `src/client/pages/Account.tsx`: حفظ challengeId/invitationId من ApiError 503، عرض حالة إرسال غير مؤكدة، retry للرسالة نفسها دون إنشاء تلقائي، موافقات الاستلام عند consentRequired=true فقط، pagination وفلاتر خادم وLoad more، رابط /admin/managed لنوعي root. حارس registerNavigationGuard(flush) محفوظ كما هو.
- `src/server/routes/admin.ts`: تعديل GET /reviews وGET /users فقط، مع مساعد تحقق للمرشحات. لم تُعدّل decision أو مسارات الإدارة الأخرى.
- `src/server/services/email.ts`: تعديل cleanup والاستيرادات اللازمة فقط؛ reviewEmail وdeliverEmail لم يتغيرا.
- `tests/account-admin-fixes.test.ts`: سبعة اختبارات مستقلة تستخدم SQLite محليًا وmocks، ولا شبكة.

## العقود المستعملة والمضافة

العقد الموجود لإعادة OTP هو POST /auth/request بجسم {email,purpose,challengeId,locale}، وليس /auth/resend. إعادة الدعوة تستخدم POST /admin/outbox/:id/retry بالمعرف نفسه؛ /invitations/:id/resend غير موجود ولم نختلقه.

GET /admin/reviews وGET /admin/users يقبلان page (افتراضي 1، أقصى 10000)، limit (افتراضي/أقصى 100)، q (حتى 100 محرف)، date (YYYY-MM-DD في UTC)، from/to (Unix seconds أو ISO UTC). النتائج {reviews,nextPage} أو {users,nextPage}، nextPage رقم أو null. ترتيب ثابت بـ created_at/id للمراجعات وpublic_id/id للمستخدمين. حالة المراجعات pending|approve|reject|changes|suspend|all؛ حالة المستخدمين all|suspended|not-suspended مع بقاء users.status='active' دائمًا. جميع مدخلات SQL مربوطة، وq مطابقة حرفية بلا wildcard interpolation. الواجهة الحالية تعرض q/status/date للمراجعات وq للمستخدمين، وتزيل فلاتر القائمة المحلية.

عقد الاستلام الذي قرئ من auth.ts أثناء الدمج: request يعيد consentRequired؛ verify يقبل acceptCustody وtermsAccepted وageConfirmed. لا ترسل الواجهة هذه الحقول للمسار العادي. يظهر قبول صريح للعمر 18+ والشروط واستلام الحساب، وتبقى ملكية العهدة على الخادم حتى OTP وموافقات صحيحة. لم يُعدّل auth.ts.

cleanup ينتقي حتى 50 سجل outbox منتهيًا مع lease منتهٍ أو فارغ، بما فيه sending/unknown، ويحذف payload والسجل ضمن auditedBatch مع شرط حيّ وتدقيق HMAC. لا retry في cleanup. يحمي lease الجاري، وينظف حتى 50 دعوة منتهية فقط مع سجل تدقيق ودون UPDATE للدعوات الحية. بقية جداول التنظيف محدودة بـ50 لكل جدول، وOTP ذو lease حيّ لا يحذف.

## التحقق

`pnpm exec vitest run tests/account-admin-fixes.test.ts tests/backend.test.ts` نجح: **39/39** (7 جديدة +32 backend). سجل التنفيذ `/tmp/idvip-subfix-tests-final.log`.

`pnpm exec tsc --noEmit` نجح، exit 0. السجل `/tmp/idvip-subfix-typecheck-final.log`.

اختبارات الجديد تشمل قوائم تتجاوز100، نتائج خارج الصفحة الأولى، فلاتر خادم قبل LIMIT، اللقطة immutable، رفض حدود/تواريخ غير صحيحة، حقن SQL والنصوص wildcard كمطابقة حرفية، حماية lease، تنظيف الدعوات bounded/audited، وعقد استلام فعلي عبر API محلي بموافقات OTP. فحص الواجهة مصدري وليس browser/render interaction.

## ما يبقى للوالد

تحديث `docs/api-contract.md`، حيث ما زال يصف GET truncated وعدم وجود pagination. الرابط /admin/managed مجرد تنقل إلى الوحدة التي يملكها الوالد، وليس ادعاء جاهزية الوحدة. cleanup ما زال request-driven opportunistic كما كان؛ السجلات أصبحت مؤهلة عند expiry بلا ساعة احتفاظ إضافية، لكنه ليس Cron ولا ضمان إزالة زمنية عند غياب الطلبات. page/offset ليس snapshot cursor، لذا قد تتغير عضوية الصفحات عند تغييرات متزامنة؛ الواجهة تمنع تكرار IDs عند append. لم يحصل Git أو Browser أو deployment أو أي طلب خارجي أو تعديل إنتاجي.
