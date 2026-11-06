import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import {
  Fingerprint,
  Save,
  Eye,
  Send,
  Trash2,
  Plus,
  Volume2,
  Bell,
  Check,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { api as backendApi, ApiError } from "../api";
import { useUI } from "../components/Context";
import {
  Busy,
  Empty,
  ErrorBox,
  Field as SharedField,
  MetalButton,
  PageHeading,
  Panel,
} from "../components/UI";
import {
  EMPTY_PROFILE,
  BRAND,
  socialNames,
  DEFAULT_SOCIALS,
  type Site,
  type User,
  type ProfileData,
  type TimelineItem,
  type MediaItem,
  type LinkItem,
  type Notification,
  type Review,
  type AuditEvent,
  type BlogPost,
  type AppSettings,
} from "../../shared/types";
import "./Account.css";

type Text = (ar: string, en: string) => string;
type Session = { user: User | null; csrf?: string; site?: Site | null };
type InAppNotification = Notification & { type?: "normal" | "special" };
type AdminUser = User & { publicationSuspended?: boolean; hasSite?: boolean };
type ReservedName = { slug: string; type: string; reason: string; fixed: boolean };
type FeatureCard = { id: string; sortOrder: number; titleAr: string; titleEn: string; bodyAr: string; bodyEn: string; published: boolean };
const blankFeature = (): FeatureCard => ({ id: "", sortOrder: 0, titleAr: "", titleEn: "", bodyAr: "", bodyEn: "", published: false });
function sitePrivacy(site: Site | null | undefined): string[] {
  const explicit = (site as (Site & { privacyHidden?: string[] }) | null | undefined)?.privacyHidden;
  return [...new Set(explicit ?? site?.published?.hidden ?? site?.draft.hidden ?? [])];
}
function Field(props: Parameters<typeof SharedField>[0]) {
  const id = useId();
  return <SharedField {...props} id={props.id || `account-field-${id}`} />;
}
const workingDrafts = new Map<
  string,
  { data: ProfileData; revision: number }
>();
function useLocalizedAPI() {
  const { lang } = useUI();
  const currentLang = useRef(lang);
  currentLang.current = lang;
  return useCallback(
    <T = any,>(
      path: string,
      options: RequestInit & { json?: unknown } = {},
    ): Promise<T> => {
      const headers = new Headers(options.headers);
      headers.set("X-Locale", currentLang.current);
      return backendApi<T>(path, {
        ...options,
        ...(["POST", "PUT"].includes(options.method || "") &&
        options.json === undefined &&
        !options.body
          ? { json: {} }
          : {}),
        headers: Object.fromEntries(headers.entries()),
      });
    },
    [],
  );
}
function message(error: unknown, t: Text): string {
  if (error instanceof ApiError) {
    if (error.code === "PRIVACY_REVIEW") return t(
      "لم نغيّر الظهور العام. زيادة الإفصاح تحتاج مسودة وطلب تعديل وموافقة، ولا يمكن إظهار ملف موقوف أو غير معتمد.",
      "Public visibility was not changed. Revealing more requires a draft, an edit request and approval; suspended or unapproved profiles cannot be shown.",
    );
    if (error.status === 503)
      return t(
        "الخدمة غير متاحة مؤقتاً. بياناتك محفوظة في هذه الشاشة؛ حاول لاحقاً.",
        "The service is temporarily unavailable. Your input remains on this screen; please try later.",
      );
    if (error.status === 409)
      return t(
        "تعارض مع نسخة أحدث أو طلب قائم. لم نستبدل بياناتك. راجع الحالة قبل المحاولة مجدداً.",
        "A newer version or existing request conflicts with this action. Your changes have not been replaced. Check the current state before retrying.",
      );
    if (error.status === 401)
      return t(
        "يرجى تسجيل الدخول من جديد لإتمام هذا الإجراء.",
        "Please sign in again to complete this action.",
      );
    if (error.status === 403)
      return t(
        "لا تملك صلاحية هذا الإجراء، أو انتهت صلاحية التحقق. أعد تسجيل الدخول.",
        "You are not authorized for this action, or verification has expired. Sign in again.",
      );
    if (error.status === 429)
      return t(
        "طلبات كثيرة خلال وقت قصير. انتظر قليلاً ثم حاول.",
        "Too many requests. Please wait a little and try again.",
      );
    if (error.status === 404 || error.status === 501)
      return t(
        "هذه الخدمة غير متاحة حالياً. لم يُنفذ أي إجراء.",
        "This service is not currently available. No action was completed.",
      );
    // The server receives locale with authentication requests; keep localized explanations where supplied.
    const parts = error.message.split(/\s*\/\s*(?=[A-Za-z])/);
    if (parts.length > 1) return t(parts[0], parts.slice(1).join(" / "));
    if (/^[\x00-\x7F]*$/.test(error.message) && t("ar", "en") === "ar")
      return t(
        "تعذر إتمام الطلب. تحقق من البيانات ثم حاول مجدداً.",
        "Unable to complete the request. Check your input and try again.",
      );
    if (/[\u0600-\u06ff]/.test(error.message) && t("ar", "en") === "en")
      return "Unable to complete the request. Check your input and try again.";
    return error.message;
  }
  if (error instanceof Error && error.name === "NotAllowedError")
    return t(
      "أُلغي التحقق من الجهاز أو لم يسمح المتصفح به. يمكنك المحاولة أو استخدام كلمة المرور.",
      "Device verification was cancelled or not allowed. Try again or use your password.",
    );
  return t(
    "تعذر الاتصال أو إتمام العملية. احتفظنا بالمدخلات؛ حاول مجدداً.",
    "Unable to connect or complete the action. Your input is preserved; please try again.",
  );
}
const localeFor = (lang: string) => (lang === "ar" ? "ar-SA" : "en-US");
const strongPassword = (v: string) =>
  v.length >= 13 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v);
const blankTimeline = (): TimelineItem => ({
  title: "",
  organization: "",
  start: "",
  end: "",
  description: "",
});
const blankMedia = (): MediaItem => ({ url: "", title: "", description: "" });
const blankLink = (): LinkItem => ({ title: "", url: "", description: "" });

export default function AccountPage({ path }: { path: string }) {
  const api = useLocalizedAPI();
  const u = useUI();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [reload, setReload] = useState(0);
  const inviteId =
    new URLSearchParams(window.location.search).get("invite") || "";
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<Session>("/session")
      .then((s) => {
        if (active) {
          setSession(s);
          u.setUser(s.user);
        }
      })
      .catch((e) => {
        if (active) setError(message(e, u.text));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, reload]);
  function authenticated(s: Session) {
    setSession(s);
    u.setUser(s.user);
    u.navigate("/account");
  }
  if (loading)
    return (
      <div className="account-page">
        <Busy />
      </div>
    );
  if (error)
    return (
      <div className="account-page">
        <PageHeading title={u.text("الحساب", "Account")} />
        <Panel>
          <ErrorBox error={error} />
          <MetalButton onClick={() => setReload((v) => v + 1)}>
            <RefreshCw size={18} />
            {u.text("إعادة المحاولة", "Retry")}
          </MetalButton>
        </Panel>
      </div>
    );
  if (path === "/create" || path === "/login" || inviteId)
    return (
      <AuthScreen
        key={path}
        signup={path === "/create" && !inviteId}
        inviteId={inviteId}
        session={session}
        onAuthenticated={authenticated}
      />
    );
  if (!session?.user)
    return (
      <div className="account-page">
        <PageHeading title={u.text("حسابك الخاص", "Your private account")} />
        <Panel>
          <Empty
            text={u.text(
              "سجّل دخولك للوصول إلى ملفك وإشعاراتك.",
              "Sign in to access your profile and notifications.",
            )}
          />
          <div className="account-actions">
            <MetalButton onClick={() => u.navigate("/login")}>
              {u.text("تسجيل الدخول", "Sign in")}
            </MetalButton>
            <MetalButton onClick={() => u.navigate("/create")}>
              {u.text("إنشاء حساب", "Create account")}
            </MetalButton>
          </div>
        </Panel>
      </div>
    );
  if (path === "/admin") return <AdminScreen user={session.user} />;
  return (
    <EditorScreen
      user={session.user}
      initialSite={session.site || null}
      onLogout={() => {
        if (session.user) workingDrafts.delete(session.user.id);
        setSession(null);
        u.setUser(null);
        u.navigate("/login");
      }}
    />
  );
}

function AuthScreen({
  signup,
  inviteId,
  session,
  onAuthenticated,
}: {
  signup: boolean;
  inviteId: string;
  session: Session | null;
  onAuthenticated: (s: Session) => void;
}) {
  const api = useLocalizedAPI();
  const u = useUI(),
    t = u.text;
  const [mode, setMode] = useState<"signup" | "login" | "recover">(
    signup ? "signup" : "login",
  );
  const [step, setStep] = useState<"details" | "code" | "security">(
    !inviteId &&
      session?.user &&
      !session.user.hasPassword &&
      !session.user.hasPasskey
      ? "security"
      : "details",
  );
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [slug, setSlug] = useState("");
  const [language, setLanguage] = useState<"ar" | "en">(u.lang);
  const [phone, setPhone] = useState(""),
    [whatsapp, setWhatsapp] = useState("");
  const [terms, setTerms] = useState(false),
    [age, setAge] = useState(false),
    [accurate, setAccurate] = useState(false);
  const [acceptInvitation, setAcceptInvitation] = useState(false);
  const [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [code, setCode] = useState(""),
    [challengeId, setChallengeId] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [availability, setAvailability] = useState<
    "idle" | "checking" | "available" | "taken" | "error"
  >("idle");
  const [availableReason, setAvailableReason] = useState("");
  const [verified, setVerified] = useState<Session | null>(session);
  const slugValid = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);
  useEffect(() => {
    if (!slug || !slugValid || mode !== "signup") {
      setAvailability("idle");
      return;
    }
    let active = true;
    setAvailability("checking");
    const timer = window.setTimeout(
      () =>
        api<{ available: boolean; reason?: string }>(
          "/availability?slug=" + encodeURIComponent(slug),
        )
          .then((r) => {
            if (active) {
              setAvailability(r.available ? "available" : "taken");
              setAvailableReason(r.reason || "");
            }
          })
          .catch(() => {
            if (active) setAvailability("error");
          }),
      450,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [slug, slugValid, mode]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(message(e, t));
    } finally {
      setBusy(false);
    }
  }
  async function request(e?: FormEvent) {
    e?.preventDefault();
    if (
      mode === "signup" &&
      (!name.trim() || !slugValid || !terms || !age || !accurate)
    ) {
      setError(
        t(
          "أكمل الاسم والنطاق والإقرارات المطلوبة.",
          "Complete your name, valid address and required acknowledgements.",
        ),
      );
      return;
    }
    if (inviteId && (!acceptInvitation || !terms || !age || !accurate)) {
      setError(
        t(
          "اقبل الدعوة والإقرارات المطلوبة أولاً.",
          "Accept the invitation and required acknowledgements first.",
        ),
      );
      return;
    }
    await run(async () => {
      const r = await api<{ challengeId: string }>("/auth/request", {
        method: "POST",
        json: {
          purpose: mode,
          email,
          locale: u.lang,
          ...(inviteId
            ? { inviteId, termsAccepted: terms, ageConfirmed: age }
            : {}),
          ...(mode === "signup"
            ? {
                name,
                slug,
                language,
                phone,
                whatsapp,
                termsAccepted: terms,
                ageConfirmed: age,
              }
            : {}),
        },
      });
      setChallengeId(r.challengeId);
      setStep("code");
      setNotice(
        t(
          "قُبلت رسالة التحقق للإرسال. افحص بريدك والرسائل غير المرغوبة.",
          "Your verification email was accepted for sending. Check your inbox and spam folder.",
        ),
      );
    });
  }
  async function verify(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await api<Session>("/auth/verify", {
        method: "POST",
        json: {
          challengeId,
          pin: code,
          locale: u.lang,
          ...(inviteId ? { acceptInvitation } : {}),
        },
      });
      setVerified(r);
      u.setUser(r.user);
      if (
        mode === "recover" ||
        mode === "signup" ||
        (!r.user?.hasPassword && !r.user?.hasPasskey)
      )
        setStep("security");
      else onAuthenticated(r);
    });
  }
  async function login(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await api<Session>("/auth/login", {
        method: "POST",
        json: { email, password, locale: u.lang },
      });
      onAuthenticated(r);
    });
  }
  async function setSecurity(e: FormEvent) {
    e.preventDefault();
    if (!strongPassword(password) || password !== confirm) {
      setError(
        t(
          "استخدم 13 محرفاً على الأقل مع رقم وحرف إنجليزي كبير وصغير، وتأكد من تطابق الكلمتين.",
          "Use at least 13 characters with a number, uppercase and lowercase English letter. Both passwords must match.",
        ),
      );
      return;
    }
    await run(async () => {
      await api("/auth/password", {
        method: "POST",
        json: { password, locale: u.lang },
      });
      const r = await api<Session>("/session");
      onAuthenticated(r);
    });
  }
  async function passkey(register: boolean) {
    await run(async () => {
      if (!browserSupportsWebAuthn())
        throw new ApiError(
          t(
            "مفاتيح المرور غير مدعومة في هذا المتصفح. استخدم كلمة مرور.",
            "Passkeys are not supported by this browser. Use a password.",
          ),
          400,
        );
      const base =
        "/auth/passkeys/" + (register ? "register" : "authentication");
      const options = await api(base + "/options", {
        method: "POST",
        json: { ...(!register && email ? { email } : {}), locale: u.lang },
      });
      const response = register
        ? await startRegistration({ optionsJSON: options.options || options })
        : await startAuthentication({
            optionsJSON: options.options || options,
          });
      await api(base + "/verify", {
        method: "POST",
        json: { challengeId: options.challengeId, response, locale: u.lang },
      });
      const s = await api<Session>("/session");
      onAuthenticated(s);
    });
  }
  if (session?.user && signup && step !== "security")
    return (
      <div className="account-page account-auth">
        <PageHeading title={t("مرحباً بعودتك", "Welcome back")} />
        <Panel>
          <p>{session.user.name}</p>
          <MetalButton onClick={() => u.navigate("/account")}>
            {t("فتح حسابي", "Open my account")}
          </MetalButton>
        </Panel>
      </div>
    );
  return (
    <div className="account-page account-auth">
      <PageHeading
        title={
          step === "security"
            ? t("أمّن حسابك", "Secure your account")
            : step === "code"
              ? t("تحقق من بريدك", "Verify your email")
              : mode === "signup"
                ? t("أنشئ عنوانك الخاص", "Create your own address")
                : mode === "recover"
                  ? t("استعادة الدخول", "Recover access")
                  : t("تسجيل الدخول", "Sign in")
        }
        subtitle={t(
          "هويتك المهنية، بعنوان يليق بك.",
          "Your professional identity, with an address that represents you.",
        )}
      />
      <Panel className="account-auth-panel">
        <div
          className="account-step"
          aria-label={t("الخطوة الحالية", "Current step")}
        >
          {step === "details" ? "01" : step === "code" ? "02" : "03"}{" "}
          <span>
            {step === "security"
              ? t("حماية الحساب", "Account protection")
              : step === "code"
                ? t("التحقق الآمن", "Secure verification")
                : t("بياناتك الأساسية", "Your details")}
          </span>
        </div>
        <ErrorBox error={error} />
        {notice && (
          <p className="account-notice" role="status">
            {notice}
          </p>
        )}
        {step === "details" && (
          <form onSubmit={mode === "login" && !inviteId ? login : request}>
            {mode === "signup" && (
              <>
                <label className="account-select-label">
                  {t("لغة محتوى ملفك", "Profile content language")}
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as "ar" | "en")}
                  >
                    <option value="ar">العربية</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <p className="account-help">
                  {t(
                    "لغة واحدة لمحتوى ملفك؛ تبديل لغة الواجهة لا يترجم سيرتك تلقائياً.",
                    "One language for your profile content. Switching the interface does not automatically translate your résumé.",
                  )}
                </p>
                <Field
                  label={t("اسمك الكامل", "Full name")}
                  value={name}
                  onChange={setName}
                  autoComplete="name"
                  required
                />
                <Field
                  label={t("عنوانك المختصر", "Your short address")}
                  value={slug}
                  onChange={(v) => setSlug(v.toLowerCase().trim())}
                  autoComplete="off"
                  maxLength={63}
                  placeholder="a"
                  dir="ltr"
                  required
                />
                <p className="account-address" dir="ltr">
                  {slug || "your-name"}.idvip.app
                </p>
                <p className="account-help" role="status">
                  {!slugValid && slug
                    ? t(
                        "حرف إنجليزي أو رقم واحد يكفي. الشرطات بين الأحرف فقط، حتى 63 محرفاً.",
                        "One English letter or digit is enough. Hyphens only between characters, up to 63 characters.",
                      )
                    : availability === "checking"
                      ? t("نتحقق من توفر العنوان…", "Checking availability…")
                      : availability === "available"
                        ? t(
                            "العنوان متاح حالياً؛ يثبت الحجز عند إتمام التحقق.",
                            "Currently available. Reservation is finalized when verification completes.",
                          )
                        : availability === "taken"
                          ? t(
                              "العنوان غير متاح أو محجوز. اختر عنواناً آخر.",
                              "The address is unavailable or reserved. Choose another.",
                            )
                          : availability === "error"
                            ? t(
                                "تعذر فحص العنوان الآن. سيُتحقق منه عند الإرسال.",
                                "Unable to check now. The server will validate it when submitted.",
                              )
                            : t(
                                "أحرف إنجليزية وأرقام وشرطات، بلا مسافات.",
                                "English letters, digits and hyphens, without spaces.",
                              )}
                  {availableReason && availability === "taken" ? "" : ""}
                </p>
              </>
            )}
            <Field
              label={t("البريد الإلكتروني", "Email address")}
              value={email}
              onChange={setEmail}
              type="email"
              autoComplete="email"
              dir="ltr"
              required
            />
            {mode === "login" && !inviteId && (
              <Field
                label={t("كلمة المرور", "Password")}
                value={password}
                onChange={setPassword}
                type="password"
                autoComplete="current-password"
                required
              />
            )}
            {inviteId && (
              <div className="account-notice">
                <p>
                  {t(
                    "دعوة VIP: لن تنتقل أي صلاحية أو ملكية إلا بعد تحقق بريدك وقبولك الصريح.",
                    "VIP invitation: no role or ownership transfers until you verify your email and explicitly accept.",
                  )}
                </p>
                <label className="account-check">
                  <input
                    type="checkbox"
                    checked={acceptInvitation}
                    onChange={(e) => setAcceptInvitation(e.target.checked)}
                    required
                  />
                  {t(
                    "أقبل الدعوة والتفويض أو نقل العهدة المرسل إليّ.",
                    "I accept the invitation and the delegation or handover addressed to me.",
                  )}
                </label>
              </div>
            )}
            {(mode === "signup" || !!inviteId) && (
              <>
                <div className="account-grid">
                  <Field
                    label={t("الهاتف (اختياري)", "Phone (optional)")}
                    value={phone}
                    onChange={setPhone}
                    type="tel"
                    autoComplete="tel"
                    dir="ltr"
                  />
                  <Field
                    label={t("واتساب (اختياري)", "WhatsApp (optional)")}
                    value={whatsapp}
                    onChange={setWhatsapp}
                    type="tel"
                    dir="ltr"
                  />
                </div>
                <label className="account-check">
                  <input
                    type="checkbox"
                    checked={terms}
                    onChange={(e) => setTerms(e.target.checked)}
                    required
                  />
                  <span>
                    {t("أوافق على", "I agree to the")}{" "}
                    <a
                      href="/terms"
                      onClick={(e) => {
                        e.preventDefault();
                        u.navigate("/terms");
                      }}
                    >
                      {t("الشروط", "terms")}
                    </a>{" "}
                    {t("و", "and")}{" "}
                    <a
                      href="/privacy"
                      onClick={(e) => {
                        e.preventDefault();
                        u.navigate("/privacy");
                      }}
                    >
                      {t("الخصوصية", "privacy policy")}
                    </a>
                    .
                  </span>
                </label>
                <label className="account-check">
                  <input
                    type="checkbox"
                    checked={age}
                    onChange={(e) => setAge(e.target.checked)}
                    required
                  />
                  {t(
                    "أؤكد أن عمري 18 عاماً أو أكثر.",
                    "I confirm that I am at least 18 years old.",
                  )}
                </label>
                <label className="account-check">
                  <input
                    type="checkbox"
                    checked={accurate}
                    onChange={(e) => setAccurate(e.target.checked)}
                    required
                  />
                  {t(
                    "أقر بصحة بياناتي وامتلاكي حق استخدام المحتوى.",
                    "I confirm my information is accurate and I have the right to use my content.",
                  )}
                </label>
              </>
            )}
            <MetalButton
              type="submit"
              disabled={
                busy ||
                (mode === "signup" &&
                  (availability === "taken" || availability === "checking"))
              }
            >
              {busy
                ? t("جارٍ الإتمام…", "Working…")
                : mode === "login" && !inviteId
                  ? t("دخول آمن", "Secure sign in")
                  : t("أرسل رمز التحقق", "Send verification code")}
            </MetalButton>
            {mode === "login" && !inviteId && (
              <>
                <MetalButton
                  type="button"
                  onClick={() => passkey(false)}
                  disabled={busy}
                >
                  <Fingerprint size={20} />
                  {t("الدخول بمفتاح مرور", "Sign in with a passkey")}
                </MetalButton>
                <div className="account-links">
                  <button
                    type="button"
                    onClick={() => {
                      setMode("recover");
                      setPassword("");
                      setError("");
                    }}
                  >
                    {t("نسيت كلمة المرور؟", "Forgot your password?")}
                  </button>
                  <button
                    type="button"
                    onClick={request}
                    disabled={busy || !email.includes("@")}
                  >
                    {t("الدخول برمز البريد", "Sign in with an email code")}
                  </button>
                </div>
              </>
            )}
            <button
              type="button"
              className="account-text-button"
              onClick={() =>
                u.navigate(mode === "signup" ? "/login" : "/create")
              }
            >
              {mode === "signup"
                ? t("لدي حساب بالفعل", "I already have an account")
                : t("إنشاء حساب جديد", "Create a new account")}
            </button>
          </form>
        )}
        {step === "code" && (
          <form onSubmit={verify}>
            <p>
              {t(
                "أدخل رمز البريد المكوّن من 6 أرقام.",
                "Enter the 6-digit code from your email.",
              )}
            </p>
            <p className="account-help" dir="ltr">
              {email}
            </p>
            <Field
              label={t("رمز التحقق", "Verification code")}
              value={code}
              onChange={(v) => setCode(v.replace(/[^0-9]/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              dir="ltr"
              required
            />
            <MetalButton type="submit" disabled={busy || code.length !== 6}>
              {busy
                ? t("جارٍ التحقق…", "Verifying…")
                : t("تحقق وتابع", "Verify and continue")}
            </MetalButton>
            <button
              type="button"
              className="account-text-button"
              onClick={() => {
                setStep("details");
                setCode("");
                setError("");
              }}
              disabled={busy}
            >
              {t(
                "تعديل البريد أو طلب رمز جديد",
                "Change email or request a new code",
              )}
            </button>
          </form>
        )}
        {step === "security" && (
          <form onSubmit={setSecurity}>
            <p>
              {t(
                "اختر كلمة مرور قوية أو مفتاح مرور يستخدم قفل جهازك. لا نجمع بصمتك.",
                "Choose a strong password or a passkey using your device lock. We do not collect your fingerprint.",
              )}
            </p>
            <p className="account-help">{verified?.user?.email}</p>
            <Field
              label={t("كلمة مرور جديدة", "New password")}
              value={password}
              onChange={setPassword}
              type="password"
              minLength={13}
              autoComplete="new-password"
              required
            />
            <Field
              label={t("تأكيد كلمة المرور", "Confirm password")}
              value={confirm}
              onChange={setConfirm}
              type="password"
              autoComplete="new-password"
              required
            />
            <p className="account-help">
              {t(
                "13 محرفاً على الأقل، مع رقم وحرف إنجليزي كبير وصغير.",
                "At least 13 characters including a number, an uppercase and a lowercase English letter.",
              )}
            </p>
            <MetalButton type="submit" disabled={busy}>
              {t(
                "حفظ كلمة المرور وفتح الحساب",
                "Save password and open account",
              )}
            </MetalButton>
            <MetalButton
              type="button"
              onClick={() => passkey(true)}
              disabled={busy}
            >
              <Fingerprint size={20} />
              {t(
                "استخدم بصمة الجهاز / مفتاح مرور",
                "Use device biometrics / passkey",
              )}
            </MetalButton>
          </form>
        )}
      </Panel>
    </div>
  );
}

function EditorScreen({
  user,
  initialSite,
  onLogout,
}: {
  user: User;
  initialSite: Site | null;
  onLogout: () => void;
}) {
  const api = useLocalizedAPI();
  const u = useUI(),
    t = u.text;
  const [site, setSite] = useState<Site | null>(initialSite),
    [data, setData] = useState<ProfileData>(
      initialSite?.draft || structuredClone(EMPTY_PROFILE),
    );
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [actionBusy, setActionBusy] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "queued" | "saving" | "saved" | "failed" | "conflict"
  >("idle");
  const [deleteOpen, setDeleteOpen] = useState(false),
    [deleteText, setDeleteText] = useState(""),
    [deleteVerified, setDeleteVerified] = useState(false);
  const privacyHidden = useRef<string[]>(sitePrivacy(initialSite));
  const latest = useRef(data),
    revision = useRef(initialSite?.revision ?? 0),
    change = useRef(0),
    savedChange = useRef(0),
    ready = useRef(false),
    conflict = useRef(false),
    saving = useRef<Promise<boolean> | null>(null),
    timer = useRef<number | null>(null),
    mounted = useRef(true);
  const textRef = useRef(t);
  textRef.current = t;
  const flush = useCallback(async (): Promise<boolean> => {
    if (!ready.current || conflict.current) return !conflict.current;
    if (saving.current) {
      const ok = await saving.current;
      if (!ok) return false;
      return flush();
    }
    if (change.current === savedChange.current) return true;
    if (timer.current !== null) clearTimeout(timer.current);
    const version = change.current,
      snapshot = structuredClone(latest.current),
      expected = revision.current;
    if (mounted.current) setSaveState("saving");
    const request = (async () => {
      try {
        const r = await api<{ site?: Site; revision?: number }>(
          "/sites/me/draft",
          { method: "PUT", json: { data: snapshot, revision: expected } },
        );
        const nextRevision = r.site?.revision ?? r.revision;
        if (!Number.isInteger(nextRevision) || nextRevision! <= expected)
          throw new Error("Missing save revision");
        revision.current = nextRevision!;
        // A save response may race an immediate hide. Saving cannot reveal fields.
        if (r.site) privacyHidden.current = [...new Set([...privacyHidden.current, ...sitePrivacy(r.site)])];
        savedChange.current = version;
        if (change.current === version) workingDrafts.delete(user.id);
        else
          workingDrafts.set(user.id, {
            data: structuredClone(latest.current),
            revision: revision.current,
          });
        if (mounted.current) {
          if (r.site)
            setSite((s) =>
              s ? { ...s, ...r.site, draft: latest.current } : r.site!,
            );
          setSaveState(change.current === version ? "saved" : "queued");
          setError("");
        }
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) conflict.current = true;
        if (mounted.current) {
          setSaveState(conflict.current ? "conflict" : "failed");
          setError(message(e, textRef.current));
        }
        return false;
      } finally {
        saving.current = null;
      }
    })();
    saving.current = request;
    return request;
  }, []);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    api<{ site: Site | null }>("/sites/me")
      .then((r) => {
        if (!active) return;
        setSite(r.site);
        privacyHidden.current = sitePrivacy(r.site);
        if (r.site) {
          const working = workingDrafts.get(user.id),
            value = structuredClone(working?.data || r.site.draft);
          latest.current = value;
          setData(value);
          revision.current = working?.revision ?? r.site.revision;
          ready.current = true;
          if (working) {
            change.current = 1;
            savedChange.current = 0;
            if (working.revision !== r.site.revision) {
              conflict.current = true;
              setSaveState("conflict");
              setError(
                t(
                  "حُفظت تعديلاتك في هذه الجلسة، لكن توجد نسخة أحدث على الخادم. لم نستبدل بياناتك.",
                  "Your working changes were kept in this session, but a newer server version exists. Your input was not overwritten.",
                ),
              );
            } else setSaveState("queued");
          }
        }
      })
      .catch((e) => {
        if (active) setError(message(e, t));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const leave = () => {
      void flush();
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (change.current !== savedChange.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false;
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      void flush();
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [flush]);
  useEffect(() => {
    if (!ready.current || saveState !== "queued" || conflict.current) return;
    timer.current = window.setTimeout(() => {
      void flush();
    }, 5000);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [data, saveState, flush]);
  function edit<K extends keyof ProfileData>(key: K, value: ProfileData[K]) {
    const next = { ...latest.current, [key]: value };
    latest.current = next;
    change.current++;
    workingDrafts.set(user.id, {
      data: structuredClone(next),
      revision: revision.current,
    });
    setData(next);
    if (!conflict.current) setSaveState("queued");
  }
  async function action(fn: () => Promise<void>) {
    setActionBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e, t));
      if (e instanceof ApiError && e.status === 409) {
        // Refresh disclosure state only: never overwrite the user's working draft.
        try {
          const r = await api<{ site: Site | null }>("/sites/me");
          privacyHidden.current = sitePrivacy(r.site);
          setSite(r.site ? { ...r.site, draft: latest.current } : null);
        } catch { /* The original conflict remains visible. */ }
      }
    } finally {
      setActionBusy(false);
    }
  }
  function field(
    key: keyof ProfileData,
    ar: string,
    en: string,
    type = "text",
    textarea = false,
  ) {
    return (
      <div className="editor-field" key={key}>
        <Field
          label={t(ar, en)}
          value={String(data[key] ?? "")}
          onChange={(v) => edit(key, v as never)}
          type={type}
          textarea={textarea}
        />
        <label className="editor-hide">
          <input
            type="checkbox"
            checked={data.hidden.includes(key)}
            disabled={actionBusy}
            onChange={(e) => hide(key, e.target.checked)}
          />
          {t("إخفاء الحقل", "Hide field")}
        </label>
        <p className="editor-privacy-status">{privacyStatus(key)}</p>
      </div>
    );
  }
  function groupKeys(key: string): string[] {
    return key === "personal"
      ? ["name", "email", "whatsapp", "phone", "specialty", "country", "city"]
      : key === "identity"
        ? ["logo", "cover"]
        : [key];
  }
  function privacyStatus(key: string): string {
    const group = groupKeys(key);
    const draftHidden = group.every((k) => data.hidden.includes(k));
    if (!site?.published) return draftHidden
      ? t("مخفي في المسودة الخاصة؛ لا توجد نسخة عامة.", "Hidden in the private draft; there is no public version.")
      : t("ظاهر في المسودة الخاصة فقط حتى الموافقة.", "Shown only in the private draft until approval.");
    const publiclyHidden = new Set([...privacyHidden.current, ...site.published.hidden]);
    if (draftHidden && !group.every((k) => publiclyHidden.has(k))) return t("مخفي في المسودة؛ لم يتأكد إخفاؤه العام بعد.", "Hidden in the draft; public hiding has not yet been confirmed.");
    if (group.some((k) => publiclyHidden.has(k))) return draftHidden
      ? t("مخفي عن الزوار.", "Hidden from visitors.")
      : t("الإظهار في المسودة فقط؛ يبقى مخفياً عاماً حتى طلب تعديل وموافقة.", "Shown in the draft only; still hidden publicly until an edit is submitted and approved.");
    return t("ظاهر في النسخة المعتمدة.", "Visible in the approved version.");
  }
  function hide(key: string, hidden: boolean) {
    const group = groupKeys(key),
      keys = hidden
        ? [...new Set([...latest.current.hidden, ...group])]
        : latest.current.hidden.filter((k) => !group.includes(k));
    edit("hidden", keys);
    if (hidden && site)
      void action(async () => {
        const hiddenKeys = [...new Set([...privacyHidden.current, ...group])];
        const r = await api<{ site: Site }>("/sites/me/visibility", {
          method: "POST",
          json: { hidden: hiddenKeys },
        });
        privacyHidden.current = sitePrivacy(r.site);
        setSite((s) =>
          s ? { ...s, ...r.site, draft: latest.current } : r.site,
        );
        u.toast(t("أُخفي المحتوى عن الزوار", "Content hidden from visitors"));
      });
    else if (!hidden) u.toast(t("الإظهار في المسودة فقط. أرسل طلب التعديل لاعتماده؛ لم نكشف المحتوى للعامة.", "Shown in the draft only. Submit the edit for approval; no public content was revealed."));
  }
  function section(key: string, ar: string, en: string, children: ReactNode) {
    return (
      <Panel className="editor-section" key={key}>
        <div className="editor-section-heading">
          <h2>{t(ar, en)}</h2>
          <label className="editor-hide">
            <input
              type="checkbox"
              checked={groupKeys(key).every((k) => data.hidden.includes(k))}
              disabled={actionBusy}
              onChange={(e) => hide(key, e.target.checked)}
            />
            {t("إخفاء القسم", "Hide section")}
          </label>
        </div>
        <p className="editor-privacy-status">{privacyStatus(key)}</p>
        {children}
      </Panel>
    );
  }
  function timeline(
    key: "experience" | "education" | "training" | "awards",
    ar: string,
    en: string,
  ) {
    const items = data[key];
    return section(
      key,
      ar,
      en,
      <>
        {items.map((item, i) => (
          <div className="editor-item" key={i}>
            <div className="editor-item-heading">
              <strong>
                {t(ar, en)} {i + 1}
              </strong>
              <button
                className="account-text-button"
                type="button"
                onClick={() =>
                  edit(
                    key,
                    items.filter((_, j) => i !== j),
                  )
                }
              >
                <Trash2 size={16} />
                {t("حذف", "Remove")}
              </button>
            </div>
            <div className="account-grid">
              {(["title", "organization", "start", "end"] as const).map(
                (k, j) => (
                  <Field
                    key={k}
                    label={t(
                      ["العنوان", "الجهة", "من", "إلى"][j],
                      ["Title", "Organization", "From", "To"][j],
                    )}
                    value={item[k]}
                    onChange={(v) =>
                      edit(
                        key,
                        items.map((x, n) => (n === i ? { ...x, [k]: v } : x)),
                      )
                    }
                  />
                ),
              )}
            </div>
            <Field
              label={t("الوصف", "Description")}
              value={item.description}
              onChange={(v) =>
                edit(
                  key,
                  items.map((x, n) => (n === i ? { ...x, description: v } : x)),
                )
              }
              textarea
            />
          </div>
        ))}
        <MetalButton
          type="button"
          onClick={() => edit(key, [...items, blankTimeline()])}
        >
          <Plus size={17} />
          {t("إضافة", "Add")}
        </MetalButton>
      </>,
    );
  }
  function mediaSection(key: "workSamples" | "proofs", ar: string, en: string) {
    return section(
      key,
      ar,
      en,
      <div className="editor-media-grid">
        {Array.from({ length: 3 }, (_, i) => {
          const item = data[key][i] || blankMedia();
          const update = (part: Partial<MediaItem>) =>
            edit(
              key,
              Array.from({ length: 3 }, (_, j) =>
                j === i ? { ...item, ...part } : data[key][j] || blankMedia(),
              ),
            );
          return (
            <div className="editor-item" key={i}>
              <h3>
                {t("الصورة", "Image")} {i + 1}
              </h3>
              <ImageUpload
                value={item.url}
                onChange={(url) => update({ url })}
              />
              <Field
                label={t("العنوان", "Title")}
                value={item.title}
                onChange={(title) => update({ title })}
              />
              <Field
                label={t("الوصف", "Description")}
                value={item.description}
                onChange={(description) => update({ description })}
                textarea
              />
            </div>
          );
        })}
      </div>,
    );
  }
  function linksSection(
    key: "videoLinks" | "links",
    count: number,
    ar: string,
    en: string,
  ) {
    return section(
      key,
      ar,
      en,
      <>
        {Array.from({ length: count }, (_, i) => {
          const item = data[key][i] || blankLink();
          const update = (part: Partial<LinkItem>) =>
            edit(
              key,
              Array.from({ length: count }, (_, j) =>
                j === i ? { ...item, ...part } : data[key][j] || blankLink(),
              ),
            );
          return (
            <div className="editor-item" key={i}>
              <h3>
                {t("الرابط", "Link")} {i + 1}
              </h3>
              <div className="account-grid">
                <Field
                  label={t("العنوان", "Title")}
                  value={item.title}
                  onChange={(title) => update({ title })}
                />
                <Field
                  label={t("الرابط الكامل", "Full URL")}
                  value={item.url}
                  onChange={(url) => update({ url })}
                  type="url"
                  dir="ltr"
                />
              </div>
              <Field
                label={t("الوصف", "Description")}
                value={item.description || ""}
                onChange={(description) => update({ description })}
              />
            </div>
          );
        })}
      </>,
    );
  }
  const statusText = {
    idle: t("مسودتك الخاصة", "Your private draft"),
    queued: t("تغييرات بانتظار الحفظ…", "Changes queued for saving…"),
    saving: t("جارٍ حفظ المسودة…", "Saving draft…"),
    saved: t("موقعك محفوظ كمسودة", "Your site is saved as a draft"),
    failed: t(
      "لم يتم الحفظ؛ بياناتك هنا",
      "Not saved; your changes remain here",
    ),
    conflict: t(
      "تعارض النسخ — احتفظنا بتعديلاتك",
      "Version conflict — your changes are preserved",
    ),
  }[saveState];
  const siteStatus = (s: Site["status"]) =>
    ({
      draft: t("مسودة", "Draft"),
      review: t("قيد المراجعة", "In review"),
      published: t("منشور", "Published"),
      suspended: t("موقوف", "Suspended"),
      hidden: t("مخفي", "Hidden"),
    })[s];
  if (loading)
    return (
      <div className="account-page">
        <Busy />
      </div>
    );
  return (
    <div className="account-page editor-page">
      <PageHeading
        title={t("مساحتك الخاصة", "Your private workspace")}
        subtitle={
          site
            ? `${site.slug}.idvip.app · ${siteStatus(site.status)}`
            : user.name
        }
      />
      <div className="account-actions editor-toolbar">
        <MetalButton
          onClick={() =>
            action(async () => {
              if (await flush()) u.navigate("/preview");
            })
          }
          disabled={actionBusy || !site}
        >
          <Eye size={18} />
          {t("معاينة", "Preview")}
        </MetalButton>
        {user.role !== "user" && (
          <MetalButton
            onClick={() =>
              action(async () => {
                if (await flush()) u.navigate("/admin");
              })
            }
          >
            {t("لوحة الإدارة", "Administration")}
          </MetalButton>
        )}
        <button
          type="button"
          className="account-text-button"
          onClick={() =>
            action(async () => {
              if (!(await flush())) return;
              await api("/auth/logout", { method: "POST" });
              onLogout();
            })
          }
          disabled={actionBusy}
        >
          {t("تسجيل الخروج", "Sign out")}
        </button>
      </div>
      <ErrorBox error={error} />
      {!site ? (
        <Panel>
          <Empty
            text={t(
              "لا يوجد ملف مرتبط بهذا الحساب. أنشئ عنوانك أو تواصل مع الدعم.",
              "No profile is linked to this account. Create your address or contact support.",
            )}
          />
          <MetalButton onClick={() => u.navigate("/create")}>
            {t("إنشاء ملف", "Create profile")}
          </MetalButton>
        </Panel>
      ) : (
        <>
          <div
            className={`editor-save-status editor-save-${saveState}`}
            role="status"
          >
            <Save size={17} />
            <span>{statusText}</span>
            {(saveState === "failed" || saveState === "queued") && (
              <button type="button" onClick={() => void flush()}>
                {t("حفظ الآن", "Save now")}
              </button>
            )}
            {saveState === "conflict" && (
              <button
                type="button"
                onClick={() => {
                  const blob = new Blob(
                    [JSON.stringify(latest.current, null, 2)],
                    { type: "application/json" },
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "vip-working-draft.json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                {t(
                  "تنزيل تعديلاتي للاحتفاظ بها",
                  "Download my changes for safekeeping",
                )}
              </button>
            )}
          </div>
          <p className="account-help">
            {t(
              "الحفظ تلقائي بعد 5 ثوانٍ من التوقف وعند الانتقال. التعديلات لا تظهر للزوار قبل الموافقة.",
              "Autosaves after 5 seconds of inactivity and when you leave. Changes are not public until approved.",
            )}
          </p>
          {section(
            "personal",
            "البيانات الشخصية",
            "Personal information",
            <div className="account-grid">
              {field("name", "الاسم الكامل", "Full name")}
              {field("specialty", "التخصص", "Specialty")}
              {field("email", "البريد الإلكتروني", "Email", "email")}
              {field("phone", "الهاتف", "Phone", "tel")}
              {field("whatsapp", "واتساب", "WhatsApp", "tel")}
              {field("country", "الدولة", "Country")}
              {field("city", "المدينة", "City")}
            </div>,
          )}
          {section(
            "bio",
            "نبذة عنك",
            "About you",
            field(
              "bio",
              "النبذة المهنية",
              "Professional biography",
              "text",
              true,
            ),
          )}
          {timeline("experience", "الخبرات", "Experience")}
          {timeline("education", "التعليم", "Education")}
          {timeline("training", "التدريب", "Training")}
          {section(
            "languages",
            "اللغات",
            "Languages",
            <>
              {data.languages.map((item, i) => (
                <div className="editor-item account-grid" key={i}>
                  <Field
                    label={t("اللغة", "Language")}
                    value={item.name}
                    onChange={(name) =>
                      edit(
                        "languages",
                        data.languages.map((x, j) =>
                          j === i ? { ...x, name } : x,
                        ),
                      )
                    }
                  />
                  <Field
                    label={t("الإتقان %", "Proficiency %")}
                    value={String(item.level)}
                    onChange={(v) =>
                      edit(
                        "languages",
                        data.languages.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                level: Math.max(
                                  0,
                                  Math.min(100, Number(v) || 0),
                                ),
                              }
                            : x,
                        ),
                      )
                    }
                    type="number"
                    min={0}
                    max={100}
                  />
                  <button
                    type="button"
                    className="account-text-button"
                    onClick={() =>
                      edit(
                        "languages",
                        data.languages.filter((_, j) => j !== i),
                      )
                    }
                  >
                    {t("حذف اللغة", "Remove language")}
                  </button>
                </div>
              ))}
              <MetalButton
                onClick={() =>
                  edit("languages", [
                    ...data.languages,
                    { name: "", level: 100 },
                  ])
                }
              >
                <Plus size={17} />
                {t("إضافة لغة", "Add language")}
              </MetalButton>
            </>,
          )}
          {(["skills", "hobbies"] as const).map((key) =>
            section(
              key,
              key === "skills" ? "المهارات" : "الهوايات",
              key === "skills" ? "Skills" : "Hobbies",
              <>
                {data[key].map((item, i) => (
                  <div className="editor-list-row" key={i}>
                    <Field
                      label={
                        t(
                          key === "skills" ? "مهارة" : "هواية",
                          key === "skills" ? "Skill" : "Hobby",
                        ) + ` ${i + 1}`
                      }
                      value={item}
                      onChange={(v) =>
                        edit(
                          key,
                          data[key].map((x, j) => (j === i ? v : x)),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("حذف", "Remove")}
                      onClick={() =>
                        edit(
                          key,
                          data[key].filter((_, j) => j !== i),
                        )
                      }
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                ))}
                <MetalButton onClick={() => edit(key, [...data[key], ""])}>
                  <Plus size={17} />
                  {t("إضافة", "Add")}
                </MetalButton>
              </>,
            ),
          )}
          {timeline(
            "awards",
            "الجوائز والأوسمة والدروع",
            "Awards, honors and shields",
          )}
          {section(
            "note",
            "ملاحظة",
            "Note",
            field("note", "ملاحظتك", "Your note", "text", true),
          )}
          {mediaSection("workSamples", "نماذج أعمالك", "Work samples")}
          {mediaSection("proofs", "إثبات المهارات", "Skills evidence")}
          {section(
            "youtube",
            "الفيديو الرئيسي",
            "Main video",
            field("youtube", "رابط YouTube الرئيسي", "Main YouTube URL", "url"),
          )}
          {linksSection(
            "videoLinks",
            7,
            "روابط الفيديو السبعة",
            "Seven video links",
          )}
          {linksSection("links", 3, "روابطك الإضافية", "Additional links")}
          {section(
            "socials",
            "حسابات التواصل",
            "Social accounts",
            <>
              <p className="account-help">
                {t(
                  "الروابط الافتراضية للمواقع الأصلية حتى تخصيص حساباتك.",
                  "Defaults link to the original platforms until you customize your accounts.",
                )}
              </p>
              <div className="account-grid">
                {socialNames.map((key) => (
                  <Field
                    key={key}
                    label={
                      {
                        linkedin: "LinkedIn",
                        facebook: "Facebook",
                        instagram: "Instagram",
                        x: "X",
                        youtube: "YouTube",
                        snapchat: "Snapchat",
                        tiktok: "TikTok",
                        telegram: "Telegram",
                      }[key]
                    }
                    value={data.socials[key] ?? DEFAULT_SOCIALS[key]}
                    onChange={(v) =>
                      edit("socials", { ...data.socials, [key]: v })
                    }
                    type="url"
                    dir="ltr"
                  />
                ))}
              </div>
            </>,
          )}
          {section(
            "identity",
            "الشعار والغلاف",
            "Logo and cover",
            <div className="account-grid">
              <div>
                <h3>{t("الشعار", "Logo")}</h3>
                <ImageUpload
                  value={data.logo}
                  onChange={(v) => edit("logo", v)}
                />
                <p className="account-help">
                  {t(
                    "عند تركه فارغاً يظهر شعار VIP الافتراضي المناسب للوضع.",
                    "Leave empty to use the VIP default logo for the current theme.",
                  )}
                </p>
              </div>
              <div>
                <h3>{t("الغلاف", "Cover")}</h3>
                <ImageUpload
                  value={data.cover}
                  onChange={(v) => edit("cover", v)}
                />
                <p className="account-help">
                  {t(
                    "عند تركه فارغاً يظهر غلاف VIP الافتراضي.",
                    "Leave empty to use the default VIP cover.",
                  )}
                </p>
              </div>
            </div>,
          )}
          <Panel className="editor-section">
            <h2>{t("الظهور والخصوصية", "Visibility and privacy")}</h2>
            <p className="account-help">
              {t(
                "يسري الإخفاء بعد تأكيده. إعادة إظهار المحتوى المخفي تتطلب المراجعة.",
                "Hiding takes effect after confirmation. Restoring hidden content requires review.",
              )}
            </p>
            <label className="account-check">
              <input
                type="checkbox"
                checked={site.visible}
                disabled={actionBusy}
                onChange={(e) => {
                  const visible = e.target.checked;
                  void action(async () => {
                    const r = await api<{ site: Site }>(
                      "/sites/me/visibility",
                      { method: "POST", json: { visible } },
                    );
                    setSite((s) =>
                      s ? { ...s, ...r.site, draft: latest.current } : r.site,
                    );
                  });
                }}
              />
              {t("الملف ظاهر للزوار", "Profile is visible to visitors")}
            </label>
            <label className="account-check">
              <input
                type="checkbox"
                checked={site.discoverable}
                disabled={actionBusy}
                onChange={(e) => {
                  const discoverable = e.target.checked;
                  void action(async () => {
                    const r = await api<{ site: Site }>(
                      "/sites/me/visibility",
                      { method: "POST", json: { discoverable } },
                    );
                    setSite((s) =>
                      s ? { ...s, ...r.site, draft: latest.current } : r.site,
                    );
                  });
                }}
              />
              {t("الظهور في بحث المنصة", "Appear in platform search")}
            </label>
          </Panel>
          <Panel className="editor-submit">
            <h2>{t("جاهز للمراجعة؟", "Ready for review?")}</h2>
            <p>
              {site.published
                ? t(
                    "نسختك المنشورة تبقى كما هي حتى اعتماد التعديلات.",
                    "Your published version stays unchanged until the edits are approved.",
                  )
                : t(
                    "أرسل ملفك للمراجعة. لن يظهر علناً قبل الموافقة.",
                    "Send your profile for review. It will not be public before approval.",
                  )}
            </p>
            <MetalButton
              disabled={actionBusy || !!site.pendingReview || conflict.current}
              onClick={() =>
                action(async () => {
                  if (!(await flush())) return;
                  const r = await api<{ reviewId: string; site?: Site }>(
                    "/sites/me/submit",
                    { method: "POST" },
                  );
                  setSite((s) =>
                    s
                      ? {
                          ...s,
                          ...(r.site || {}),
                          draft: latest.current,
                          pendingReview: r.reviewId,
                          status: s.published ? s.status : "review",
                        }
                      : s,
                  );
                  u.toast(t("أُرسل للمراجعة", "Submitted for review"));
                })
              }
            >
              <Send size={18} />
              {site.pendingReview
                ? t("طلبك قيد المراجعة", "Your request is in review")
                : t("أرسل للمراجعة", "Submit for review")}
            </MetalButton>
          </Panel>
        </>
      )}
      <Notifications />
      <Panel className="account-security">
        <h2>{t("أمان الحساب", "Account security")}</h2>
        <SecurityTools />{" "}
        <button
          className="account-danger-link"
          type="button"
          onClick={() => {
            setDeleteOpen((v) => !v);
            setDeleteVerified(false);
            setDeleteText("");
          }}
        >
          {t(
            "حذف حسابي وملفي نهائياً",
            "Permanently delete my account and profile",
          )}
        </button>
        {deleteOpen && (
          <div className="account-danger">
            <p>
              {t(
                "سيُحذف الحساب والملف ومحتواهما. هذا الإجراء لا يمكن التراجع عنه. أعد التحقق من هويتك، ثم اكتب DELETE حرفياً.",
                "Your account, profile and their content will be deleted. This cannot be undone. Reauthenticate, then type DELETE exactly.",
              )}
            </p>
            <Reauthentication
              key={String(deleteOpen)}
              email={user.email}
              onVerified={() => setDeleteVerified(true)}
            />
            <Field
              label={t("اكتب DELETE", "Type DELETE")}
              value={deleteText}
              onChange={setDeleteText}
              dir="ltr"
            />
            <MetalButton
              className="account-danger-button"
              disabled={
                actionBusy || deleteText !== "DELETE" || !deleteVerified
              }
              onClick={() =>
                action(async () => {
                  await api("/sites/me", {
                    method: "DELETE",
                    json: { confirmation: "DELETE" },
                  });
                  ready.current = false;
                  workingDrafts.delete(user.id);
                  if (timer.current !== null) clearTimeout(timer.current);
                  onLogout();
                })
              }
            >
              <Trash2 size={18} />
              {t("حذف نهائي", "Delete permanently")}
            </MetalButton>
            <button
              type="button"
              className="account-text-button"
              onClick={() => setDeleteOpen(false)}
            >
              {t("إلغاء", "Cancel")}
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}

async function optimizeImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Unable to convert image"))),
        "image/webp",
        0.8,
      ),
    );
    if (blob.type !== "image/webp")
      throw new Error("WebP conversion unavailable");
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", {
      type: "image/webp",
    });
  } finally {
    bitmap.close();
  }
}
function ImageUpload({
  value,
  onChange,
}: {
  value: string;
  onChange: (url: string) => void;
}) {
  const api = useLocalizedAPI();
  const u = useUI(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 8 * 1024 * 1024
    ) {
      setError(
        u.text(
          "اختر صورة JPG أو PNG أو WebP لا تتجاوز 8 ميغابايت.",
          "Choose a JPG, PNG or WebP image no larger than 8 MB.",
        ),
      );
      return;
    }
    setBusy(true);
    try {
      const optimized = await optimizeImage(file);
      const form = new FormData();
      form.append("file", optimized);
      const r = await api<{ url?: string; media?: { url: string } }>("/media", {
        method: "POST",
        body: form,
      });
      const url = r.media?.url || r.url;
      if (!url) throw new Error("Missing media URL");
      onChange(url);
    } catch (e) {
      setError(message(e, u.text));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="editor-upload">
      {value && (
        <img
          src={value}
          alt={u.text("الصورة المرفوعة", "Uploaded image")}
          loading="lazy"
        />
      )}
      <label className="editor-file-label">
        {busy
          ? u.text("جارٍ تحسين الصورة ورفعها…", "Optimizing and uploading…")
          : u.text("اختر صورة", "Choose an image")}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      <p className="account-help">
        {u.text(
          "حتى 8 MB؛ نحولها إلى WebP مع الحفاظ على الشفافية، وبُعد أقصى 1600 بكسل.",
          "Up to 8 MB. Converted to WebP with transparency preserved and a maximum dimension of 1600 pixels.",
        )}
      </p>
      {value && (
        <button
          type="button"
          className="account-text-button"
          disabled={busy}
          onClick={() => onChange("")}
        >
          {u.text("إزالة الصورة", "Remove image")}
        </button>
      )}
      <ErrorBox error={error} />
    </div>
  );
}
function SecurityTools() {
  const api = useLocalizedAPI();
  const u = useUI(),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e, u.text));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="account-security-details">
      <summary>
        {u.text("كلمة المرور ومفاتيح المرور", "Password and passkeys")}
      </summary>
      <ErrorBox error={error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!strongPassword(password) || password !== confirm) {
            setError(
              u.text(
                "كلمة المرور تحتاج 13 محرفاً ورقماً وكبيراً وصغيراً، مع تطابق التأكيد.",
                "Use at least 13 characters, a number, uppercase and lowercase letter, and matching confirmation.",
              ),
            );
            return;
          }
          void run(async () => {
            await api("/auth/password", {
              method: "POST",
              json: { password, locale: u.lang },
            });
            setPassword("");
            setConfirm("");
            u.toast(u.text("حُفظت كلمة المرور", "Password saved"));
          });
        }}
      >
        <Field
          label={u.text("كلمة مرور جديدة", "New password")}
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="new-password"
          required
        />
        <Field
          label={u.text("تأكيد كلمة المرور", "Confirm password")}
          value={confirm}
          onChange={setConfirm}
          type="password"
          autoComplete="new-password"
          required
        />
        <MetalButton type="submit" disabled={busy}>
          {u.text("حفظ كلمة المرور", "Save password")}
        </MetalButton>
      </form>
      <MetalButton
        disabled={busy}
        onClick={() =>
          run(async () => {
            const options = await api("/auth/passkeys/register/options", {
              method: "POST",
              json: { locale: u.lang },
            });
            const response = await startRegistration({
              optionsJSON: options.options || options,
            });
            await api("/auth/passkeys/register/verify", {
              method: "POST",
              json: { challengeId: options.challengeId, response },
            });
            u.toast(u.text("أُضيف مفتاح المرور", "Passkey added"));
          })
        }
      >
        <Fingerprint size={18} />
        {u.text("إضافة مفتاح مرور", "Add a passkey")}
      </MetalButton>
    </details>
  );
}

function Notifications() {
  const api = useLocalizedAPI(), u = useUI(), t = u.text;
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [sound, setSound] = useState(() => {
    try { return localStorage.getItem("vip-notification-sound") === "yes"; } catch { return false; }
  });
  const [soundReady, setSoundReady] = useState(false);
  const audio = useRef<AudioContext | null>(null), enabled = useRef(false), soundRef = useRef(sound);
  const known = useRef<Set<string> | null>(null);
  soundRef.current = sound;
  // A saved preference never bypasses the browser's user-gesture requirement.
  async function activateSound() {
    try {
      const Audio = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Audio) throw new Error("Audio unsupported");
      audio.current ||= new Audio();
      await audio.current.resume();
      if (audio.current.state !== "running") throw new Error("Audio blocked");
      enabled.current = true; setSoundReady(true); setSound(true); soundRef.current = true;
      try { localStorage.setItem("vip-notification-sound", "yes"); } catch { /* optional preference */ }
      await tone("normal");
    } catch {
      enabled.current = false; setSoundReady(false);
      setError(t("لم يسمح المتصفح بتشغيل الصوت. أعد الضغط أو تابع بالإشعارات النصية.", "The browser did not allow sound. Try the button again or use text notifications."));
    }
  }
  async function tone(type: "normal" | "special"): Promise<boolean> {
    const context = audio.current;
    if (!enabled.current || !soundRef.current || !context || context.state !== "running" || document.visibilityState !== "visible") return false;
    try {
      const start = context.currentTime;
      const offsets = type === "special" ? [0, 0.32] : [0];
      for (const offset of offsets) {
        for (const [frequency, level] of [[880, 0.026], [1397, 0.013], [2093, 0.006]]) {
          const oscillator = context.createOscillator(), gain = context.createGain();
          oscillator.type = "sine"; oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, start + offset);
          gain.gain.exponentialRampToValueAtTime(level, start + offset + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.26);
          oscillator.connect(gain); gain.connect(context.destination);
          oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
          oscillator.start(start + offset); oscillator.stop(start + offset + 0.28);
        }
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, type === "special" ? 640 : 300));
      return context.state === "running" && document.visibilityState === "visible";
    } catch { return false; }
  }
  useEffect(() => {
    let active = true, fetching = false;
    async function refresh() {
      if (fetching || document.visibilityState !== "visible") return;
      fetching = true;
      try {
        const r = await api<{ notifications: InAppNotification[] }>("/notifications");
        if (!active) return;
        const previous = known.current;
        const newcomers = previous ? r.notifications.filter((n) => !previous.has(n.id) && !n.heard) : [];
        known.current = new Set(r.notifications.map((n) => n.id));
        setItems(r.notifications);
        if (newcomers.length && await tone(newcomers.some((n) => n.type === "special") ? "special" : "normal")) {
          for (const n of newcomers) {
            if (!active) break;
            await api(`/notifications/${encodeURIComponent(n.id)}/heard`, { method: "POST" });
            if (active) setItems((v) => v.map((x) => x.id === n.id ? { ...x, heard: true } : x));
          }
        }
      } catch (e) { if (active) setError(message(e, t)); }
      finally { fetching = false; if (active) setLoading(false); }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false; clearInterval(interval); document.removeEventListener("visibilitychange", onVisible);
      enabled.current = false; void audio.current?.close(); audio.current = null;
      window.speechSynthesis?.cancel();
    };
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(message(e, t)); } finally { setBusy(false); }
  }
  async function listen(n: InAppNotification) {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setError(t("الاستماع غير مدعوم في هذا المتصفح؛ الإشعار النصي متاح ولم نسجل أنه سُمع.", "Listening is not supported by this browser; the text is available and it was not marked heard.")); return;
    }
    await new Promise<void>((resolve, reject) => {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(n.title + ". " + n.body);
      utterance.lang = u.lang === "ar" ? "ar-SA" : "en-US";
      const timeout = window.setTimeout(() => { window.speechSynthesis.cancel(); reject(new Error("Speech timeout")); }, 120000);
      utterance.onend = () => { clearTimeout(timeout); resolve(); };
      utterance.onerror = () => { clearTimeout(timeout); reject(new Error("Speech unavailable")); };
      window.speechSynthesis.speak(utterance);
    });
    await api(`/notifications/${encodeURIComponent(n.id)}/heard`, { method: "POST" });
    setItems((v) => v.map((x) => x.id === n.id ? { ...x, heard: true } : x));
  }
  return <Panel className="account-notifications">
    <div className="editor-section-heading"><h2><Bell size={20} />{t("الإشعارات", "Notifications")}</h2>
      <label className="account-check"><input type="checkbox" checked={sound} onChange={(e) => {
        if (e.target.checked) void activateSound();
        else { setSound(false); soundRef.current = false; enabled.current = false; setSoundReady(false); try { localStorage.setItem("vip-notification-sound", "no"); } catch { /* optional */ } }
      }} />{t("صوت داخل التطبيق", "In-app sound")}</label>
    </div>
    <div className="account-actions">
      <button type="button" className="account-text-button" onClick={() => void activateSound()}><Volume2 size={17} />{sound && soundReady ? t("تجربة النغمة المعدنية", "Test metallic tone") : t("السماح بتشغيل الصوت لهذه الجلسة", "Enable sound for this session")}</button>
    </div>
    <p className="account-help">{t("الصوت اختياري بعد ضغطك ويعمل أثناء فتح التطبيق فقط، حسب دعم المتصفح وسياسة تشغيله. النغمة العادية خفيفة والمميزة مزدوجة. لا نرسل Push أو صوتاً خارج التطبيق، وكتم الجهاز قد يمنع سماع النغمة.", "Sound is optional after your click and only works while the app is open, subject to browser support and playback policy. The ordinary tone is light; the special tone is double. No Push or sound outside the app is sent, and device mute may prevent hearing it.")}</p>
    <ErrorBox error={error} />
    {loading ? <Busy /> : !items.length ? <Empty text={t("لا توجد إشعارات.", "No notifications.")} /> : <>
      <button type="button" className="account-text-button" disabled={busy} onClick={() => act(async () => {
        await api("/notifications", { method: "DELETE" }); setItems([]); known.current = new Set();
      })}>{t("حذف جميع الإشعارات", "Delete all notifications")}</button>
      {items.map((n) => <article className={`account-notification ${n.read ? "" : "account-notification-unread"} ${n.type === "special" ? "account-notification-special" : ""}`} key={n.id}>
        <div className="editor-section-heading"><h3>{n.title}</h3><span className="admin-badge">{n.type === "special" ? t("مميز", "Special") : t("عادي", "Normal")}</span></div>
        <p className="account-notification-body">{n.body}</p><time>{new Date(n.createdAt).toLocaleString(localeFor(u.lang))}</time>
        <p className="account-help">{n.read ? t("مقروء", "Read") : t("غير مقروء", "Unread")} · {n.heard ? t("شُغّل صوته / سُمع", "Audio played / heard") : t("لم يُسمع", "Not heard")}</p>
        <div className="account-actions">
          <button type="button" className="account-text-button" disabled={busy || n.read} onClick={() => act(async () => {
            await api(`/notifications/${encodeURIComponent(n.id)}/read`, { method: "POST" });
            setItems((v) => v.map((x) => x.id === n.id ? { ...x, read: true } : x));
          })}><Check size={16} />{n.read ? t("مقروء", "Read") : t("تحديد كمقروء", "Mark as read")}</button>
          <button type="button" className="account-text-button" disabled={busy} onClick={() => act(() => listen(n))}><Volume2 size={16} />{n.heard ? t("استمع مجدداً", "Listen again") : t("استمع", "Listen")}</button>
          <button type="button" className="account-text-button" disabled={busy} onClick={() => act(async () => {
            await api(`/notifications/${encodeURIComponent(n.id)}`, { method: "DELETE" });
            setItems((v) => v.filter((x) => x.id !== n.id)); known.current?.delete(n.id);
          })}><Trash2 size={16} />{t("حذف", "Delete")}</button>
        </div>
      </article>)}
    </>}
  </Panel>;
}

type AdminTab =
  | "reviews"
  | "users"
  | "settings"
  | "audit"
  | "blogs"
  | "features"
  | "notifications"
  | "reserves";
function AdminScreen({ user }: { user: User }) {
  const api = useLocalizedAPI();
  const u = useUI(),
    t = u.text;
  const permitted = ["owner", "principal", "moderator"].includes(user.role),
    full = user.role === "owner" || user.role === "principal";
  const [tab, setTab] = useState<AdminTab>("reviews"),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [reviews, setReviews] = useState<Review[]>([]),
    [users, setUsers] = useState<AdminUser[]>([]),
    [events, setEvents] = useState<AuditEvent[]>([]),
    [blogs, setBlogs] = useState<BlogPost[]>([]),
    [reserves, setReserves] = useState<ReservedName[]>([]),
    [features, setFeatures] = useState<FeatureCard[]>([]),
    [feature, setFeature] = useState<FeatureCard>(blankFeature);
  const [settings, setSettings] = useState<AppSettings>({
    homeLocked: false,
    platformLocked: false,
  });
  const [filter, setFilter] = useState(""),
    [status, setStatus] = useState("pending"),
    [date, setDate] = useState("");
  const [inviteEmail, setInviteEmail] = useState(""),
    [inviteName, setInviteName] = useState(""),
    [inviteRole, setInviteRole] = useState<"moderator" | "principal">(
      "moderator",
    ),
    [inviteMode, setInviteMode] = useState("moderator");
  const [inviteSlug, setInviteSlug] = useState(""),
    [inviteLanguage, setInviteLanguage] = useState<"ar" | "en">(u.lang),
    [inviteSiteId, setInviteSiteId] = useState("");
  const [deleteId, setDeleteId] = useState(""),
    [deleteConfirm, setDeleteConfirm] = useState("");
  const [adminDeleteVerified, setAdminDeleteVerified] = useState(false);
  const [blog, setBlog] = useState<BlogPost>({
    id: "",
    slug: "",
    titleAr: "",
    titleEn: "",
    bodyAr: "",
    bodyEn: "",
    published: false,
  });
  const [noticeTitle, setNoticeTitle] = useState(""),
    [noticeBody, setNoticeBody] = useState(""),
    [audience, setAudience] = useState("all"),
    [publicIds, setPublicIds] = useState("");
  const [noticeType, setNoticeType] = useState<"normal" | "special">("normal");
  const [reserveSlug, setReserveSlug] = useState(""),
    [reserveReason, setReserveReason] = useState(""),
    [reserveType, setReserveType] = useState("custom");
  useEffect(() => {
    if (!permitted) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    async function load() {
      switch (tab) {
        case "reviews": {
          const r = await api<{ reviews: Review[] }>(
            "/admin/reviews?status=all",
          );
          if (active) setReviews(r.reviews);
          break;
        }
        case "users": {
          const r = await api<{ users: AdminUser[] }>("/admin/users");
          if (active) setUsers(r.users);
          break;
        }
        case "settings": {
          const r = await api<AppSettings & { settings?: AppSettings }>(
            "/settings",
          );
          if (active) setSettings(r.settings || r);
          break;
        }
        case "audit": {
          const r = await api<{ events: AuditEvent[] }>("/admin/audit");
          if (active) setEvents(r.events);
          break;
        }
        case "blogs": {
          const r = await api<{ posts: BlogPost[] }>("/admin/blogs");
          if (active) setBlogs(r.posts);
          break;
        }
        case "reserves": {
          const r = await api<{
            reserves: ReservedName[];
          }>("/admin/reserves");
          if (active) setReserves(r.reserves);
          break;
        }
        case "features": {
          const r = await api<{ features: FeatureCard[] }>("/admin/features");
          if (active) setFeatures(r.features);
          break;
        }
        case "notifications":
          break;
      }
    }
    load()
      .catch((e) => {
        if (active) setError(message(e, t));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tab, refresh, permitted]);
  async function act(
    fn: () => Promise<void>,
    success = t("تم حفظ الإجراء", "Action saved"),
  ) {
    setBusy(true);
    setError("");
    try {
      await fn();
      u.toast(success);
    } catch (e) {
      setError(message(e, t));
    } finally {
      setBusy(false);
    }
  }
  if (!permitted)
    return (
      <div className="account-page">
        <PageHeading title={t("الإدارة", "Administration")} />
        <Panel>
          <ErrorBox
            error={t(
              "هذه المساحة مخصصة للمشرفين المصرح لهم.",
              "This workspace is reserved for authorized administrators.",
            )}
          />
          <MetalButton onClick={() => u.navigate("/account")}>
            {t("العودة لحسابي", "Back to my account")}
          </MetalButton>
        </Panel>
      </div>
    );
  const tabs: [AdminTab, string, string][] = [
    ["reviews", "طلبات المراجعة", "Reviews"],
    ["users", "المستخدمون", "Users"],
    ["settings", "الإعدادات", "Settings"],
    ["audit", "سجل التدقيق", "Audit log"],
    ["blogs", "المدونات", "Blogs"],
    ["features", "المزايا", "Features"],
    ["notifications", "إرسال إشعار", "Send notification"],
    ["reserves", "الأسماء المحجوزة", "Reserved names"],
  ];
  const filtered = reviews.filter(
    (r) =>
      (!status || r.status === status) &&
      (!date || r.createdAt.slice(0, 10) === date) &&
      (!filter ||
        `${r.id} ${r.slug} ${r.userName} ${r.userEmail}`
          .toLowerCase()
          .includes(filter.toLowerCase())),
  );
  return (
    <div className="account-page admin-page">
      <PageHeading
        title={t("إدارة VIP", "VIP administration")}
        subtitle={t(
          "بطاقة واضحة، قرار واحد، وأثر موثق.",
          "A clear review card, one decision, and an auditable record.",
        )}
      />
      <div className="account-actions">
        <MetalButton onClick={() => u.navigate("/account")}>
          {t("حسابي", "My account")}
        </MetalButton>
        <button
          className="account-text-button"
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw size={17} />
          {t("تحديث", "Refresh")}
        </button>
        <span className="admin-role">
          {user.role === "owner"
            ? t("المالك", "Owner")
            : user.role === "principal"
              ? t("مشرف أعلى", "Principal")
              : t("مشرف", "Moderator")}
        </span>
      </div>
      <nav
        className="admin-tabs"
        aria-label={t("أقسام الإدارة", "Administration sections")}
      >
        {tabs.map(([key, ar, en]) => (
          <button
            type="button"
            key={key}
            className={tab === key ? "admin-tab-active" : ""}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => {
              setTab(key);
              setError("");
            }}
          >
            {t(ar, en)}
          </button>
        ))}
      </nav>
      <ErrorBox error={error} />
      {loading ? (
        <Busy />
      ) : (
        <>
          {tab === "reviews" && (
            <>
              <Panel>
                <div className="admin-filters">
                  <Field
                    label={t(
                      "الاسم أو العنوان أو معرف الطلب",
                      "Name, address or review ID",
                    )}
                    value={filter}
                    onChange={setFilter}
                  />
                  <label className="account-select-label">
                    {t("الحالة", "Status")}
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="">
                        {t("كل الحالات", "All statuses")}
                      </option>
                      {[
                        "pending",
                        "approve",
                        "reject",
                        "changes",
                        "suspend",
                      ].map((v, i) => (
                        <option key={v} value={v}>
                          {t(
                            [
                              "بانتظار القرار",
                              "موافق",
                              "مرفوض",
                              "تعديل مطلوب",
                              "موقوف",
                            ][i],
                            [
                              "Pending",
                              "Approved",
                              "Rejected",
                              "Changes requested",
                              "Suspended",
                            ][i],
                          )}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Field
                    label={t("التاريخ", "Date")}
                    value={date}
                    onChange={setDate}
                    type="date"
                  />
                </div>
              </Panel>
              {!filtered.length ? (
                <Empty
                  text={t("لا توجد طلبات مطابقة.", "No matching reviews.")}
                />
              ) : (
                filtered.map((r) => (
                  <ReviewCard
                    key={r.id}
                    review={r}
                    busy={busy}
                    decide={(decision, note) =>
                      act(
                        async () => {
                          await api(
                            `/admin/reviews/${encodeURIComponent(r.id)}/decision`,
                            { method: "POST", json: { decision, note } },
                          );
                          setRefresh((v) => v + 1);
                        },
                        t("تم تسجيل القرار", "Decision recorded"),
                      )
                    }
                  />
                ))
              )}
            </>
          )}
          {tab === "users" && (
            <>
              <Panel>
                <h2>{t("دعوة وتفويض", "Invite and delegate")}</h2>
                <p className="account-help">
                  {t(
                    "الصلاحيات لا تُمنح إلا بعد تحقق البريد. الحساب المدار أو نقل العهدة يتطلبان قبول المستفيد.",
                    "Permissions require verified email. Managed accounts or handover require acceptance by the recipient.",
                  )}
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(
                      async () => {
                        await api("/admin/invite", {
                          method: "POST",
                          json: {
                            email: inviteEmail,
                            ...(inviteName ? { name: inviteName } : {}),
                            role:
                              inviteMode === "moderator" ? inviteRole : "user",
                            ...(inviteMode === "managed"
                              ? { slug: inviteSlug, language: inviteLanguage }
                              : {}),
                            ...(inviteMode === "handover"
                              ? { siteId: inviteSiteId }
                              : {}),
                            mode: inviteMode,
                            locale: u.lang,
                          },
                        });
                        setInviteEmail("");
                        setInviteName("");
                        setRefresh((v) => v + 1);
                      },
                      t("أُرسلت الدعوة", "Invitation sent"),
                    );
                  }}
                >
                  <div className="account-grid">
                    <Field
                      label={t("البريد المدعو", "Invitee email")}
                      value={inviteEmail}
                      onChange={setInviteEmail}
                      type="email"
                      required
                    />
                    <Field
                      label={t("الاسم (اختياري)", "Name (optional)")}
                      value={inviteName}
                      onChange={setInviteName}
                      required={inviteMode === "managed"}
                    />
                    <label className="account-select-label">
                      {t("الصلاحية", "Role")}
                      <select
                        value={inviteRole}
                        onChange={(e) =>
                          setInviteRole(e.target.value as typeof inviteRole)
                        }
                        disabled={!full || inviteMode !== "moderator"}
                      >
                        <option value="moderator">
                          {t("مشرف", "Moderator")}
                        </option>
                        {full && (
                          <option value="principal">
                            {t("مشرف أعلى كامل", "Full principal")}
                          </option>
                        )}
                      </select>
                    </label>
                    <label className="account-select-label">
                      {t("نوع الدعوة", "Invitation mode")}
                      <select
                        value={inviteMode}
                        onChange={(e) => setInviteMode(e.target.value)}
                      >
                        <option value="moderator">
                          {t("تفويض إشراف", "Moderation delegation")}
                        </option>
                        <option value="managed">
                          {t("حساب مدار", "Managed account")}
                        </option>
                        <option value="handover">
                          {t("نقل عهدة", "Account handover")}
                        </option>
                      </select>
                    </label>
                  </div>
                  {inviteMode === "managed" && (
                    <div className="account-grid">
                      <Field
                        label={t("عنوان الملف الجديد", "New profile address")}
                        value={inviteSlug}
                        onChange={(v) => setInviteSlug(v.toLowerCase().trim())}
                        required
                        pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                      />
                      <label className="account-select-label">
                        {t("لغة الملف", "Profile language")}
                        <select
                          value={inviteLanguage}
                          onChange={(e) =>
                            setInviteLanguage(e.target.value as "ar" | "en")
                          }
                        >
                          <option value="ar">العربية</option>
                          <option value="en">English</option>
                        </select>
                      </label>
                    </div>
                  )}
                  {inviteMode === "handover" && (
                    <Field
                      label={t(
                        "المعرف الداخلي للملف المراد نقله",
                        "Internal ID of the profile to hand over",
                      )}
                      value={inviteSiteId}
                      onChange={setInviteSiteId}
                      required
                    />
                  )}
                  <MetalButton type="submit" disabled={busy || !full}>
                    <Send size={17} />
                    {t("إرسال الدعوة", "Send invitation")}
                  </MetalButton>
                  {!full && (
                    <p className="account-help">
                      {t(
                        "التفويض والحذف محجوزان للمالك والمشرف الأعلى.",
                        "Delegation and deletion are reserved for the owner and principal.",
                      )}
                    </p>
                  )}
                </form>
              </Panel>
              <Panel>
                <Field
                  label={t("بحث المستخدمين", "Search users")}
                  value={filter}
                  onChange={setFilter}
                />
                {users
                  .filter((x) =>
                    `${x.name} ${x.email} ${x.publicId}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                  )
                  .map((x) => (
                    <article className="admin-user" key={x.id}>
                      <div>
                        <h3>{x.name}</h3>
                        <p dir="ltr">
                          {x.email} · c/{x.publicId}
                        </p>
                      </div>
                      <label className="account-select-label">
                        {t("الصلاحية", "Role")}
                        <select
                          value={x.role}
                          disabled={
                            !full ||
                            busy ||
                            x.role === "owner" ||
                            BRAND.owners.includes(x.email) ||
                            x.id === user.id
                          }
                          onChange={(e) => {
                            const role = e.target.value;
                            void act(async () => {
                              await api(
                                `/admin/users/${encodeURIComponent(x.id)}/role`,
                                { method: "POST", json: { role } },
                              );
                              setUsers((v) =>
                                v.map((y) =>
                                  y.id === x.id
                                    ? { ...y, role: role as User["role"] }
                                    : y,
                                ),
                              );
                            });
                          }}
                        >
                          {(
                            (x.role === "owner"
                              ? ["owner"]
                              : [
                                  "user",
                                  "moderator",
                                  "principal",
                                ]) as User["role"][]
                          ).map((role, i) => (
                            <option value={role} key={role}>
                              {t(
                                ["مستخدم", "مشرف", "مشرف أعلى", "المالك"][i],
                                ["User", "Moderator", "Principal", "Owner"][i],
                              )}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="account-actions admin-publication-actions">
                        <button type="button" className="account-text-button" disabled={busy || x.hasSite === false || x.publicationSuspended === true} onClick={() => act(async () => {
                          await api(`/admin/users/${encodeURIComponent(x.id)}/publication`, { method: "POST", json: { suspended: true } });
                          setUsers((v) => v.map((y) => y.id === x.id ? { ...y, publicationSuspended: true } : y));
                        }, t("أُوقف نشر الملف", "Profile publication suspended"))}>{t("إيقاف النشر", "Suspend publication")}</button>
                        <button type="button" className="account-text-button" disabled={busy || x.hasSite === false || x.publicationSuspended === false} onClick={() => act(async () => {
                          await api(`/admin/users/${encodeURIComponent(x.id)}/publication`, { method: "POST", json: { suspended: false } });
                          setUsers((v) => v.map((y) => y.id === x.id ? { ...y, publicationSuspended: false } : y));
                        }, t("رُفع إيقاف النشر؛ إعدادات الخصوصية محفوظة", "Publication suspension lifted; privacy settings preserved"))}>{t("رفع الإيقاف", "Restore publication")}</button>
                      </div>
                      {full &&
                        x.role !== "owner" &&
                        !BRAND.owners.includes(x.email) &&
                        x.id !== user.id && (
                          <button
                            type="button"
                            className="account-danger-link"
                            onClick={() => {
                              setDeleteId(x.id);
                              setDeleteConfirm("");
                              setAdminDeleteVerified(false);
                            }}
                          >
                            {t("حذف", "Delete")}
                          </button>
                        )}
                    </article>
                  ))}
                {!users.length && (
                  <Empty text={t("لا يوجد مستخدمون.", "No users.")} />
                )}
                {deleteId && full && (
                  <div className="account-danger">
                    <p>
                      {t(
                        "حذف المستخدم وملفه نهائي. اكتب DELETE للتأكيد.",
                        "Deleting this user and their profile is permanent. Type DELETE to confirm.",
                      )}
                    </p>
                    <Reauthentication
                      key={deleteId}
                      email={user.email}
                      onVerified={() => setAdminDeleteVerified(true)}
                    />
                    <Field
                      label={t("التأكيد DELETE", "Confirmation DELETE")}
                      value={deleteConfirm}
                      onChange={setDeleteConfirm}
                    />
                    <MetalButton
                      disabled={
                        busy ||
                        deleteConfirm !== "DELETE" ||
                        !adminDeleteVerified
                      }
                      className="account-danger-button"
                      onClick={() =>
                        act(async () => {
                          await api(
                            `/admin/users/${encodeURIComponent(deleteId)}`,
                            {
                              method: "DELETE",
                              json: { confirmation: "DELETE" },
                            },
                          );
                          setDeleteId("");
                          setRefresh((v) => v + 1);
                        })
                      }
                    >
                      {t("حذف نهائي", "Delete permanently")}
                    </MetalButton>
                    <button
                      type="button"
                      className="account-text-button"
                      onClick={() => setDeleteId("")}
                    >
                      {t("إلغاء", "Cancel")}
                    </button>
                  </div>
                )}
              </Panel>
            </>
          )}
          {tab === "settings" && (
            <Panel>
              <h2>{t("أقفال مستقلة", "Independent access locks")}</h2>
              <p>
                {t(
                  "لا تمنع الأقفال الإدارة أو صفحات الحقوق والدعم.",
                  "Locks do not block administration, legal rights or support pages.",
                )}
              </p>
              <label className="account-check">
                <input
                  type="checkbox"
                  checked={!!settings.homeLocked}
                  disabled={busy}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, homeLocked: e.target.checked }))
                  }
                />
                {t("قفل الرئيسية", "Lock home page")}
              </label>
              <label className="account-check">
                <input
                  type="checkbox"
                  checked={!!settings.platformLocked}
                  disabled={busy}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      platformLocked: e.target.checked,
                    }))
                  }
                />
                {t("صيانة المنصة", "Platform maintenance")}
              </label>
              <MetalButton
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api("/admin/settings", {
                      method: "PUT",
                      json: settings,
                    });
                  })
                }
              >
                {t("حفظ الإعدادات", "Save settings")}
              </MetalButton>
            </Panel>
          )}
          {tab === "audit" && (
            <Panel>
              <h2>{t("سجل التدقيق — قراءة فقط", "Audit log — read only")}</h2>
              <div className="account-actions">
                <a
                  className="account-export"
                  href="/api/admin/audit/export?format=json"
                  download
                >
                  JSON
                </a>
                <a
                  className="account-export"
                  href="/api/admin/audit/export?format=csv"
                  download
                >
                  CSV
                </a>
              </div>
              <Field
                label={t("تصفية السجل", "Filter log")}
                value={filter}
                onChange={setFilter}
              />
              {events
                .filter((e) =>
                  `${e.id} ${e.actor} ${e.action} ${e.object} ${e.outcome}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                )
                .map((e) => (
                  <article className="admin-audit" key={e.id}>
                    <div>
                      <strong>{e.action}</strong>
                      <time>
                        {new Date(e.createdAt).toLocaleString(
                          localeFor(u.lang),
                        )}
                      </time>
                    </div>
                    <p>
                      {t("المنفذ", "Actor")}: {e.actor} ·{" "}
                      {t("العنصر", "Object")}: {e.object}
                    </p>
                    <p>
                      {t("النتيجة", "Outcome")}: {e.outcome}
                    </p>
                    <code>
                      {e.id} · {e.hash}
                    </code>
                  </article>
                ))}
              {!events.length && (
                <Empty text={t("لا توجد أحداث.", "No events.")} />
              )}
            </Panel>
          )}
          {tab === "blogs" && (
            <>
              <Panel>
                <div className="editor-section-heading">
                  <h2>{t("المدونات", "Blogs")}</h2>
                  <button
                    type="button"
                    className="account-text-button"
                    onClick={() =>
                      setBlog({
                        id: "",
                        slug: "",
                        titleAr: "",
                        titleEn: "",
                        bodyAr: "",
                        bodyEn: "",
                        published: false,
                      })
                    }
                  >
                    <Plus size={17} />
                    {t("مدونة جديدة", "New post")}
                  </button>
                </div>
                {blogs.map((b) => (
                  <button
                    className="admin-blog-row"
                    type="button"
                    key={b.id}
                    onClick={() => setBlog({ ...b })}
                  >
                    {u.lang === "ar" ? b.titleAr : b.titleEn}
                    <span>
                      {b.published
                        ? t("منشور", "Published")
                        : t("مسودة", "Draft")}
                    </span>
                  </button>
                ))}
              </Panel>
              <Panel>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const id = blog.id || crypto.randomUUID();
                      const { id: _id, ...payload } = blog;
                      const r = await api<{ post: BlogPost }>(
                        `/admin/blogs/${encodeURIComponent(id)}`,
                        { method: "PUT", json: payload },
                      );
                      setBlog(r.post);
                      setRefresh((v) => v + 1);
                    });
                  }}
                >
                  <Field
                    label={t("عنوان الرابط", "URL slug")}
                    value={blog.slug}
                    onChange={(slug) => setBlog((b) => ({ ...b, slug }))}
                    dir="ltr"
                    required
                  />
                  <div className="account-grid">
                    <div lang="ar" dir="rtl">
                      <Field
                        label={t("العنوان بالعربية", "Arabic title")}
                        value={blog.titleAr}
                        onChange={(titleAr) =>
                          setBlog((b) => ({ ...b, titleAr }))
                        }
                        required
                      />
                      <Field
                        label={t("النص بالعربية", "Arabic content")}
                        value={blog.bodyAr}
                        onChange={(bodyAr) =>
                          setBlog((b) => ({ ...b, bodyAr }))
                        }
                        textarea
                        required
                      />
                    </div>
                    <div lang="en" dir="ltr">
                      <Field
                        label={t("العنوان بالإنجليزية", "English title")}
                        value={blog.titleEn}
                        onChange={(titleEn) =>
                          setBlog((b) => ({ ...b, titleEn }))
                        }
                        required
                      />
                      <Field
                        label={t("النص بالإنجليزية", "English content")}
                        value={blog.bodyEn}
                        onChange={(bodyEn) =>
                          setBlog((b) => ({ ...b, bodyEn }))
                        }
                        textarea
                        required
                      />
                    </div>
                  </div>
                  <label className="account-check">
                    <input
                      type="checkbox"
                      checked={blog.published}
                      onChange={(e) =>
                        setBlog((b) => ({ ...b, published: e.target.checked }))
                      }
                    />
                    {t("منشور", "Published")}
                  </label>
                  <MetalButton type="submit" disabled={busy}>
                    {t("حفظ المدونة", "Save post")}
                  </MetalButton>
                </form>
              </Panel>
            </>
          )}
          {tab === "features" && <>
            <Panel>
              <div className="editor-section-heading"><h2>{t("مزايا المنصة", "Platform features")}</h2><button type="button" className="account-text-button" disabled={busy} onClick={() => setFeature(blankFeature())}><Plus size={17} />{t("ميزة جديدة", "New feature")}</button></div>
              <p className="account-help">{t("نصوص عربية وإنجليزية دائماً. احفظ للنشر أو كمسودة، ورتب البطاقات برقم بسيط. الحذف للمالك والمشرف الأعلى فقط.", "Arabic and English text is always required. Save as published or draft, and order cards with a simple number. Deletion is limited to the owner and principal.")}</p>
              {!features.length && <Empty text={t("لم تضف مزايا مدارة بعد.", "No managed features yet.")} />}
              {features.map((f) => <div className="admin-feature-row" key={f.id}>
                <button className="admin-blog-row" type="button" disabled={busy} onClick={() => setFeature({ ...f })}>
                  <span>{f.sortOrder}</span><strong>{t(f.titleAr, f.titleEn)}</strong><span>{f.published ? t("منشور", "Published") : t("مسودة", "Draft")}</span>
                </button>
                {full && <button type="button" className="account-danger-link" disabled={busy} onClick={() => {
                  if (!window.confirm(t("حذف هذه الميزة نهائياً؟", "Permanently delete this feature?"))) return;
                  void act(async () => {
                    await api("/admin/features", { method: "PUT", json: { action: "delete", id: f.id } });
                    if (feature.id === f.id) setFeature(blankFeature());
                    setFeatures((v) => v.filter((x) => x.id !== f.id));
                  }, t("حُذفت الميزة", "Feature deleted"));
                }}><Trash2 size={16} />{t("حذف", "Delete")}</button>}
              </div>)}
            </Panel>
            <Panel>
              <form onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const id = feature.id || crypto.randomUUID();
                  const r = await api<{ feature: FeatureCard }>("/admin/features", { method: "PUT", json: {
                    id, sortOrder: feature.sortOrder, titleAr: feature.titleAr, titleEn: feature.titleEn,
                    bodyAr: feature.bodyAr, bodyEn: feature.bodyEn, published: feature.published,
                  } });
                  setFeature(r.feature); setRefresh((v) => v + 1);
                }, t("حُفظت الميزة", "Feature saved"));
              }}>
                <Field label={t("ترتيب العرض", "Display order")} value={String(feature.sortOrder)} onChange={(v) => setFeature((f) => ({ ...f, sortOrder: Number(v) }))} type="number" min={0} max={9999} step={1} required />
                <div className="account-grid">
                  <div lang="ar" dir="rtl">
                    <Field label={t("العنوان بالعربية", "Arabic title")} value={feature.titleAr} onChange={(titleAr) => setFeature((f) => ({ ...f, titleAr }))} maxLength={300} required />
                    <Field label={t("الوصف بالعربية", "Arabic description")} value={feature.bodyAr} onChange={(bodyAr) => setFeature((f) => ({ ...f, bodyAr }))} maxLength={6000} textarea required />
                  </div>
                  <div lang="en" dir="ltr">
                    <Field label={t("العنوان بالإنجليزية", "English title")} value={feature.titleEn} onChange={(titleEn) => setFeature((f) => ({ ...f, titleEn }))} maxLength={300} required />
                    <Field label={t("الوصف بالإنجليزية", "English description")} value={feature.bodyEn} onChange={(bodyEn) => setFeature((f) => ({ ...f, bodyEn }))} maxLength={6000} textarea required />
                  </div>
                </div>
                <label className="account-check"><input type="checkbox" checked={feature.published} onChange={(e) => setFeature((f) => ({ ...f, published: e.target.checked }))} />{t("منشور للعامة", "Published publicly")}</label>
                <MetalButton type="submit" disabled={busy}><Save size={17} />{t("حفظ الميزة", "Save feature")}</MetalButton>
              </form>
            </Panel>
          </>}
          {tab === "notifications" && (
            <Panel>
              <h2>{t("إرسال إشعار", "Send a notification")}</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const ids = publicIds
                    .split(/[\s,،]+/)
                    .filter(Boolean)
                    .map((x) => Number(x.replace(/^c\//, "")));
                  if (
                    audience === "selected" &&
                    (!ids.length ||
                      ids.some((x) => !Number.isInteger(x) || x < 1))
                  ) {
                    setError(
                      t(
                        "أدخل معرفات صحيحة مثل c/1، c/2.",
                        "Enter valid IDs such as c/1, c/2.",
                      ),
                    );
                    return;
                  }
                  void act(
                    async () => {
                      await api("/admin/notifications", {
                        method: "POST",
                        json: {
                          title: noticeTitle,
                          body: noticeBody,
                          type: noticeType,
                          all: audience === "all",
                          publicIds: audience === "selected" ? ids : undefined,
                          locale: u.lang,
                        },
                      });
                      setNoticeTitle("");
                      setNoticeBody("");
                    },
                    t("تم إرسال الإشعار", "Notification sent"),
                  );
                }}
              >
                <label className="account-select-label">
                  {t("المستلمون", "Recipients")}
                  <select
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                  >
                    <option value="all">
                      {t("جميع المستخدمين", "All users")}
                    </option>
                    <option value="selected">
                      {t("معرفات محددة", "Selected public IDs")}
                    </option>
                  </select>
                </label>
                <label className="account-select-label">
                  {t("نوع الإشعار داخل التطبيق", "In-app notification type")}
                  <select value={noticeType} onChange={(e) => setNoticeType(e.target.value as "normal" | "special")}>
                    <option value="normal">{t("عادي — نغمة خفيفة", "Normal — light tone")}</option>
                    <option value="special">{t("مميز — نغمة معدنية مزدوجة", "Special — double metallic tone")}</option>
                  </select>
                </label>
                <p className="account-help">{t("إشعار داخل التطبيق فقط؛ الصوت يحتاج موافقة المستخدم ودعم المتصفح، وليس Push.", "In-app notifications only; sound requires user activation and browser support, not Push.")}</p>
                {audience === "selected" && (
                  <Field
                    label={t(
                      "المعرفات مفصولة بفواصل",
                      "Comma-separated public IDs",
                    )}
                    value={publicIds}
                    onChange={setPublicIds}
                    placeholder="c/1, c/2"
                    required
                  />
                )}
                <Field
                  label={t("عنوان الإشعار", "Notification title")}
                  value={noticeTitle}
                  onChange={setNoticeTitle}
                  maxLength={300}
                  required
                />
                <Field
                  label={t("نص الإشعار", "Notification body")}
                  value={noticeBody}
                  onChange={setNoticeBody}
                  textarea
                  maxLength={6000}
                  required
                />
                <MetalButton type="submit" disabled={busy}>
                  <Send size={17} />
                  {t("إرسال", "Send")}
                </MetalButton>
              </form>
            </Panel>
          )}
          {tab === "reserves" && (
            <Panel>
              <h2>{t("الأسماء المحجوزة", "Reserved names")}</h2>
              <p className="account-help">{t("أسماء النظام والأسماء الحساسة ثابتة ولا يمكن تحريرها. الحجز والتعديل والتحرير للمالك والمشرف الأعلى فقط، ولا يحجز اسم موقع موجود أو حجز تسجيل لم ينتهِ.", "System and sensitive names are fixed and cannot be released. Reserving, editing and releasing are limited to the owner and principal; existing sites and unexpired signup reservations cannot be displaced.")}</p>
              {reserves.map((r) => <div className="admin-reserve" key={r.slug}>
                <div><strong dir="ltr">{r.slug}</strong><p>{r.fixed || r.type === "fixed_reserved" ? t("اسم نظام ثابت", "Fixed system name") : r.type === "custom" ? t("حجز مخصص", "Custom reservation") : r.type}</p><p>{r.reason}</p></div>
                {full && !r.fixed && r.type !== "fixed_reserved" && <div className="account-actions">
                  <button type="button" className="account-text-button" disabled={busy} onClick={() => { setReserveSlug(r.slug); setReserveType(r.type); setReserveReason(r.reason); }}>{t("تعديل", "Edit")}</button>
                  <button type="button" className="account-danger-link" disabled={busy} onClick={() => {
                    if (!window.confirm(t("تحرير الاسم المخصص وإتاحته للتسجيل؟", "Release this custom name for registration?"))) return;
                    void act(async () => {
                      await api("/admin/reserves", { method: "POST", json: { slug: r.slug, action: "release" } });
                      setRefresh((v) => v + 1);
                    }, t("حُرر الاسم المخصص", "Custom name released"));
                  }}><Trash2 size={16} />{t("تحرير الاسم", "Release name")}</button>
                </div>}
              </div>)}
              {full && <form onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api("/admin/reserves", { method: "POST", json: { slug: reserveSlug, type: reserveType, reason: reserveReason } });
                  setReserveSlug(""); setReserveReason(""); setReserveType("custom"); setRefresh((v) => v + 1);
                }, t("حُفظ حجز الاسم", "Name reservation saved"));
              }}>
                <Field label={t("الاسم المحجوز", "Reserved name")} value={reserveSlug} onChange={(v) => setReserveSlug(v.toLowerCase().trim())} required dir="ltr" maxLength={63} pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" />
                <Field label={t("نوع الحجز (مخصص افتراضياً)", "Reservation type (custom by default)")} value={reserveType} onChange={setReserveType} required maxLength={40} pattern="(?!fixed_reserved$).+" />
                <Field label={t("السبب (حتى 500 محرف)", "Reason (up to 500 characters)")} value={reserveReason} onChange={setReserveReason} maxLength={500} />
                <div className="account-actions"><MetalButton type="submit" disabled={busy}>{t("حفظ حجز الاسم", "Save name reservation")}</MetalButton><button type="button" className="account-text-button" disabled={busy} onClick={() => { setReserveSlug(""); setReserveReason(""); setReserveType("custom"); }}>{t("تفريغ الحقول", "Clear fields")}</button></div>
              </form>}
            </Panel>
          )}

        </>
      )}
    </div>
  );
}
function ReviewCard({
  review: r,
  busy,
  decide,
}: {
  review: Review;
  busy: boolean;
  decide: (decision: string, note: string) => Promise<void>;
}) {
  const u = useUI(),
    t = u.text,
    [note, setNote] = useState("");
  return (
    <Panel className="admin-review">
      <div className="admin-review-top">
        <div>
          <h2>{r.userName}</h2>
          <p dir="ltr">
            {r.slug}.idvip.app · #{r.id}
          </p>
        </div>
        <span className="admin-badge">
          {r.kind === "edit"
            ? t("تعديل منشور", "Published profile edit")
            : t("طلب نشر", "Publication request")}
        </span>
      </div>
      <p className="account-help">
        {t("نسخة ثابتة", "Fixed snapshot")} #{r.revision} ·{" "}
        {new Date(r.createdAt).toLocaleString(localeFor(u.lang))} ·{" "}
        {t("الحالة", "Status")}:{" "}
        {(
          {
            pending: t("بانتظار القرار", "Pending"),
            approve: t("موافق", "Approved"),
            reject: t("مرفوض", "Rejected"),
            changes: t("تعديل مطلوب", "Changes requested"),
            suspend: t("موقوف", "Suspended"),
          } as Record<string, string>
        )[r.status] || r.status}
      </p>
      <div className="account-actions">
        <a href={`mailto:${r.userEmail}`}>
          {t("تواصل بالبريد", "Email applicant")}
        </a>
        {r.whatsapp && (
          <a
            href={`https://wa.me/${r.whatsapp.replace(/\D/g, "")}`}
            target="_blank"
            rel="noreferrer"
          >
            {t("واتساب", "WhatsApp")}
          </a>
        )}
        <MetalButton
          onClick={() => u.navigate("/review/" + encodeURIComponent(r.id))}
        >
          <Eye size={17} />
          {t("معاينة النسخة المحددة", "Preview this exact version")}
        </MetalButton>
      </div>
      <details className="admin-review-preview">
        <summary>
          <ChevronDown size={17} />
          {t("عرض محتوى الطلب", "Show request content")}
        </summary>
        <ReviewData data={r.data} />
      </details>
      <Field
        label={t("ملاحظة للمستخدم (اختيارية)", "Note to the user (optional)")}
        value={note}
        onChange={setNote}
        textarea
      />
      <div className="admin-decision-actions">
        {(["approve", "reject", "changes", "suspend"] as const).map(
          (decision, i) => (
            <MetalButton
              key={decision}
              disabled={busy || r.status !== "pending"}
              className={decision === "approve" ? "admin-approve" : ""}
              onClick={() => decide(decision, note)}
            >
              {t(
                ["موافقة", "رفض", "طلب تعديل", "تعليق / إيقاف"][i],
                ["Approve", "Reject", "Request changes", "Suspend"][i],
              )}
            </MetalButton>
          ),
        )}
      </div>
    </Panel>
  );
}
function ReviewData({ data }: { data: ProfileData }) {
  const u = useUI(),
    t = u.text;
  const names: Record<keyof ProfileData, [string, string]> = {
    name: ["الاسم", "Name"],
    email: ["البريد", "Email"],
    whatsapp: ["واتساب", "WhatsApp"],
    phone: ["الهاتف", "Phone"],
    specialty: ["التخصص", "Specialty"],
    country: ["الدولة", "Country"],
    city: ["المدينة", "City"],
    bio: ["النبذة", "Biography"],
    experience: ["الخبرة", "Experience"],
    education: ["التعليم", "Education"],
    training: ["التدريب", "Training"],
    languages: ["اللغات", "Languages"],
    skills: ["المهارات", "Skills"],
    awards: ["الجوائز", "Awards"],
    hobbies: ["الهوايات", "Hobbies"],
    note: ["ملاحظة", "Note"],
    workSamples: ["الأعمال", "Work samples"],
    proofs: ["الإثباتات", "Evidence"],
    youtube: ["الفيديو الرئيسي", "Main video"],
    videoLinks: ["روابط الفيديو", "Video links"],
    links: ["روابط إضافية", "Additional links"],
    socials: ["التواصل", "Socials"],
    logo: ["الشعار", "Logo"],
    cover: ["الغلاف", "Cover"],
    hidden: ["الحقول المخفية", "Hidden fields"],
  };
  function display(value: unknown): string {
    if (Array.isArray(value))
      return value
        .map((x) =>
          typeof x === "object" && x !== null
            ? Object.values(x).join(" · ")
            : String(x),
        )
        .join("\n");
    if (value && typeof value === "object")
      return Object.entries(value)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
    return String(value ?? "");
  }
  return (
    <dl className="admin-review-data">
      {(Object.keys(names) as (keyof ProfileData)[]).map((key) => (
        <div key={key}>
          <dt>{t(...names[key])}</dt>
          <dd>{display(data[key]) || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Reauthentication({
  email,
  onVerified,
}: {
  email: string;
  onVerified: () => void;
}) {
  const api = useLocalizedAPI(),
    u = useUI(),
    t = u.text;
  const [password, setPassword] = useState(""),
    [pin, setPin] = useState(""),
    [challengeId, setChallengeId] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [verified, setVerified] = useState(false);
  async function run(fn: () => Promise<boolean>) {
    setBusy(true);
    setError("");
    try {
      if (await fn()) {
        setVerified(true);
        setPassword("");
        onVerified();
      }
    } catch (e) {
      setError(message(e, t));
    } finally {
      setBusy(false);
    }
  }
  if (verified)
    return (
      <p className="account-notice" role="status">
        {t(
          "تم التحقق من هويتك لهذا الإجراء.",
          "Your identity was verified for this action.",
        )}
      </p>
    );
  return (
    <div className="account-reauth">
      <ErrorBox error={error} />
      <p className="account-help">
        {t(
          "أعد التحقق من هويتك قبل الإجراء النهائي.",
          "Reauthenticate before the final action.",
        )}
      </p>
      <Field
        label={t("كلمة المرور للتحقق", "Password to verify")}
        value={password}
        onChange={setPassword}
        type="password"
        autoComplete="current-password"
      />
      <div className="account-actions">
        <MetalButton
          type="button"
          disabled={busy || !password}
          onClick={() =>
            run(async () => {
              const s = await api<Session>("/auth/login", {
                method: "POST",
                json: { email, password },
              });
              if (!s.user) throw new Error("No session");
              u.setUser(s.user);
              return true;
            })
          }
        >
          {t("تحقق بكلمة المرور", "Verify with password")}
        </MetalButton>
        <MetalButton
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (!browserSupportsWebAuthn())
                throw new ApiError(
                  t(
                    "المتصفح لا يدعم مفاتيح المرور. استخدم كلمة المرور أو البريد.",
                    "This browser does not support passkeys. Use a password or email.",
                  ),
                  400,
                );
              const r = await api("/auth/passkeys/authentication/options", {
                method: "POST",
                json: { email },
              });
              const response = await startAuthentication({
                optionsJSON: r.options,
              });
              const s = await api<Session>(
                "/auth/passkeys/authentication/verify",
                {
                  method: "POST",
                  json: { challengeId: r.challengeId, response },
                },
              );
              if (!s.user) throw new Error("No session");
              u.setUser(s.user);
              return true;
            })
          }
        >
          <Fingerprint size={18} />
          {t("تحقق بمفتاح المرور", "Verify with a passkey")}
        </MetalButton>
        <button
          type="button"
          className="account-text-button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await api<{ challengeId: string }>("/auth/request", {
                method: "POST",
                json: { purpose: "login", email },
              });
              setChallengeId(r.challengeId);
              u.toast(
                t(
                  "قُبل رمز التحقق للإرسال إلى بريدك.",
                  "The verification email was accepted for sending.",
                ),
              );
              return false;
            })
          }
        >
          {t("التحقق برمز البريد", "Verify with an email code")}
        </button>
      </div>
      {challengeId && (
        <>
          <Field
            label={t("رمز البريد من 6 أرقام", "6-digit email code")}
            value={pin}
            onChange={(v) => setPin(v.replace(/[^0-9]/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          />
          <MetalButton
            type="button"
            disabled={busy || pin.length !== 6}
            onClick={() =>
              run(async () => {
                const s = await api<Session>("/auth/verify", {
                  method: "POST",
                  json: { challengeId, pin },
                });
                if (!s.user) throw new Error("No session");
                u.setUser(s.user);
                return true;
              })
            }
          >
            {t("تأكيد الرمز", "Verify code")}
          </MetalButton>
        </>
      )}
    </div>
  );
}
