import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  Moon,
  Sun,
  Globe,
  Volume2,
  Accessibility,
  Download,
  X,
  Check,
} from "lucide-react";
import { UIContext, useUI } from "./components/Context";
import type { Lang, Theme, User } from "../shared/types";
import { api } from "./api";
import { Busy, MetalButton } from "./components/UI";
import Home from "./pages/Home";
import { canNavigate } from "./navigation";
import { SearchPage, FeaturesPage, BlogPage, InfoPage } from "./pages/Public";
const PushPermission = lazy(() => import("./components/PushPermission"));
const screens = import.meta.glob<{
  default: React.ComponentType<any>;
}>("./pages/{Account,Profile}.tsx");
function GatedScreen() {
  const u = useUI();
  return (
    <main className="page">
      <section className="metal-panel">
        <h1>VIP</h1>
        <p>
          {u.text(
            "هذه الوظيفة تجهز في المرحلة التالية.",
            "This feature is being prepared in the next phase.",
          )}
        </p>
        <button className="metal-button" onClick={() => u.navigate("/")}>
          {u.text("الرئيسية", "Home")}
        </button>
      </section>
    </main>
  );
}
const phase = import.meta.env.VITE_PHASE || "2";
const Account = lazy(() =>
  phase !== "1" && screens["./pages/Account.tsx"]
    ? screens["./pages/Account.tsx"]()
    : Promise.resolve({ default: GatedScreen }),
);
const Profile = lazy(() =>
  phase !== "1" && screens["./pages/Profile.tsx"]
    ? screens["./pages/Profile.tsx"]()
    : Promise.resolve({ default: GatedScreen }),
);
const Managed = lazy(() => import("./pages/Managed"));
const hostRoutes: Record<string, string> = {
  search: "/search",
  features: "/features",
  blog: "/blog",
  about: "/about",
  terms: "/terms",
  privacy: "/privacy",
  create: "/create",
  account: "/account",
  admin: "/admin",
  auth: "/login",
  test: "/test",
};
function initialPath() {
  if (typeof window === "undefined") return "/";
  const h = location.hostname.split(".")[0];
  if (location.hostname.endsWith(".idvip.app") && location.pathname === "/")
    return hostRoutes[h] || "/site/" + h;
  return location.pathname;
}
function initial<K extends string>(key: string, allowed: K[], fallback: K): K {
  if (typeof window === "undefined") return fallback;
  const q = new URLSearchParams(location.search).get(key);
  if (q && allowed.includes(q as K)) return q as K;
  try {
    const v = localStorage.getItem("vip-" + key);
    return v && allowed.includes(v as K) ? (v as K) : fallback;
  } catch {
    return fallback;
  }
}
export default function App() {
  const [lang, setLang] = useState<Lang>(() =>
    initial(
      "lang",
      ["ar", "en"],
      document.documentElement.lang === "en" ? "en" : "ar",
    ),
  );
  const [theme, setTheme] = useState<Theme>(() =>
    initial("theme", ["dark", "light"], "dark"),
  );
  const [path, setPath] = useState(initialPath);
  const [user, setUser] = useState<User | null>(null);
  const [message, setMessage] = useState("");
  const [install, setInstall] = useState<any>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [installHelp, setInstallHelp] = useState(false);
  const [cookie, setCookie] = useState(false);
  const [custom, setCustom] = useState(false);
  const [external, setExternal] = useState(false);
  const [voice, setVoice] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const text = useCallback(
    (ar: string, en: string) => (lang === "ar" ? ar : en),
    [lang],
  );
  const toast = useCallback((s: string) => {
    setMessage(s);
    setTimeout(() => setMessage(""), 5000);
  }, []);
  const speak = useCallback(
    (s: string) => {
      if (!("speechSynthesis" in window)) {
        toast(
          text(
            "الاستماع غير متاح في هذا الجهاز.",
            "Listening is not available on this device.",
          ),
        );
        return;
      }
      speechSynthesis.cancel();
      const x = new SpeechSynthesisUtterance(s);
      x.lang = lang === "ar" ? "ar-SA" : "en-US";
      speechSynthesis.speak(x);
    },
    [lang, text, toast],
  );
  const navigate = useCallback(
    async (p: string) => {
      if (!p.startsWith("/") || p.startsWith("//")) return;
      if (!(await canNavigate())) {
        toast(
          text(
            "تعذر حفظ التعديلات. بقيت في المحرر لحماية عملك.",
            "Changes could not be saved. You remain in the editor to protect your work.",
          ),
        );
        return;
      }
      const isLive =
        location.hostname === "idvip.app" ||
        location.hostname.endsWith(".idvip.app");
      const privateRoute =
        /^\/(?:create|login|account|admin|preview|review)(?:\/|\?|$)/.test(p);
      const preferences = `lang=${lang}&theme=${theme}`;
      if (isLive && privateRoute) {
        if (location.hostname !== "auth.idvip.app") {
          location.assign(
            `https://auth.idvip.app${p}${p.includes("?") ? "&" : "?"}${preferences}`,
          );
          return;
        }
      } else if (isLive) {
        if (p === "/" && location.hostname !== "idvip.app") {
          location.assign(`https://idvip.app/?${preferences}`);
          return;
        }
        const entry = Object.entries(hostRoutes).find(([, r]) => r === p);
        if (entry && location.hostname !== entry[0] + ".idvip.app") {
          location.assign(`https://${entry[0]}.idvip.app/?${preferences}`);
          return;
        }
        if (p.startsWith("/site/")) {
          const slug = p.split("/")[2];
          if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug))
            location.assign(`https://${slug}.idvip.app/?${preferences}`);
          return;
        }
      }
      history.pushState({}, "", p);
      setPath(p.split("?")[0]);
      window.scrollTo({ top: 0, behavior: "instant" });
    },
    [lang, theme, text, toast],
  );
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("vip-lang", lang);
      localStorage.setItem("vip-theme", theme);
    } catch {}
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#090b0e" : "#f3ece4");
  }, [lang, theme]);
  useEffect(() => {
    const f = async () => {
      const next = initialPath();
      if (await canNavigate()) setPath(next);
      else {
        history.pushState({}, "", path);
        toast(
          text(
            "احفظ التعديلات قبل المغادرة.",
            "Save your changes before leaving.",
          ),
        );
      }
    };
    addEventListener("popstate", f);
    return () => removeEventListener("popstate", f);
  }, [path, text, toast]);
  useEffect(() => {
    const f = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      const anchor = (e.target as Element)?.closest?.("a");
      if (
        !anchor ||
        anchor.hasAttribute("download") ||
        anchor.target === "_blank"
      )
        return;
      const href = anchor.href;
      if (!href || !/^https?:/.test(href)) return;
      const target = new URL(href);
      if (
        target.origin === location.origin &&
        target.pathname === location.pathname &&
        target.hash
      )
        return;
      e.preventDefault();
      void canNavigate().then((ok) => {
        if (ok) location.assign(target.href);
        else
          toast(
            text(
              "تعذر الحفظ؛ لم تغادر المحرر.",
              "Save failed; you have not left the editor.",
            ),
          );
      });
    };
    document.addEventListener("click", f, true);
    return () => document.removeEventListener("click", f, true);
  }, [text, toast]);
  useEffect(() => {
    api<{
      user: User | null;
      csrf: string;
    }>("/session")
      .then((r) => setUser(r.user))
      .catch(() => {});
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    try {
      setCookie(!localStorage.getItem("vip-consent"));
    } catch {
      setCookie(true);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (
        !window.matchMedia("(display-mode:standalone)").matches &&
        !sessionStorage.getItem("vip-install-dismissed")
      ) {
        setShowInstall(true);
        timer = setTimeout(() => setShowInstall(false), 3000);
      }
    } catch {}
    const f = (e: any) => {
      e.preventDefault();
      setInstall(e);
    };
    addEventListener("beforeinstallprompt", f);
    return () => {
      removeEventListener("beforeinstallprompt", f);
      if (timer) clearTimeout(timer);
    };
  }, []);
  const requestInstall = useCallback(async () => {
    if (install) {
      await install.prompt();
      const r = await install.userChoice;
      if (r.outcome === "accepted")
        toast(text("تم قبول التثبيت.", "Installation accepted."));
      setInstall(null);
      setShowInstall(false);
    } else setInstallHelp(true);
  }, [install, text, toast]);
  useEffect(() => {
    addEventListener("vip-install", requestInstall);
    return () => removeEventListener("vip-install", requestInstall);
  }, [requestInstall]);
  function consent(choice: string) {
    try {
      localStorage.setItem(
        "vip-consent",
        JSON.stringify({
          choice,
          external: choice === "all" || (choice === "partial" && external),
          version: 1,
          date: new Date().toISOString(),
        }),
      );
    } catch {}
    setCookie(false);
    setCustom(false);
    window.dispatchEvent(new Event("vip-consent-changed"));
  }
  function voiceNavigation() {
    const R =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!R) {
      toast(
        text(
          "يمكنك استخدام قارئ الشاشة أو الإملاء الصوتي في جهازك.",
          "Use your screen reader or device dictation.",
        ),
      );
      return;
    }
    const r = new R();
    r.lang = lang === "ar" ? "ar-SA" : "en-US";
    r.onresult = (e: any) => {
      const s = e.results[0][0].transcript.toLowerCase();
      const map: [string[], string][] = [
        [["بحث", "search"], "/search"],
        [["مزايا", "features"], "/features"],
        [["إنشاء", "انشاء", "create"], "/create"],
        [["العينة", "sample", "demo"], "/test"],
        [["رئيسية", "الرئيسية", "home"], "/"],
        [["خصوصية", "privacy"], "/privacy"],
        [["الشروط", "terms"], "/terms"],
        [["حساب", "account"], "/account"],
      ];
      const hit = map.find(([keys]) => keys.some((k) => s.includes(k)));
      if (hit) {
        speak(text("فتح الصفحة المطلوبة", "Opening the requested page"));
        navigate(hit[1]);
      } else
        toast(
          text(
            "قل: البحث، العينة، المزايا، الرئيسية، إنشاء موقع.",
            "Say: search, demo, features, home, create site.",
          ),
        );
      setVoiceListening(false);
    };
    r.onerror = () => setVoiceListening(false);
    r.onend = () => setVoiceListening(false);
    setVoiceListening(true);
    r.start();
  }
  let page;
  if (path === "/") page = <Home />;
  else if (path === "/search") page = <SearchPage />;
  else if (path === "/features") page = <FeaturesPage />;
  else if (path === "/blog" || path.startsWith("/blog/"))
    page = <BlogPage slug={path.split("/")[2]} />;
  else if (["/about", "/privacy", "/terms"].includes(path))
    page = <InfoPage kind={path.slice(1) as "about" | "privacy" | "terms"} />;
  else if (path === "/admin/managed" || path.startsWith("/admin/managed/"))
    page = <Managed path={path} />;
  else if (["/create", "/login", "/account", "/admin"].includes(path))
    page = <Account path={path} />;
  else if (
    path === "/test" ||
    path === "/preview" ||
    path.startsWith("/site/") ||
    path.startsWith("/review/")
  )
    page = (
      <Profile
        slug={path === "/test" ? "test" : path.split("/")[2]}
        preview={path === "/preview"}
        reviewId={path.startsWith("/review/") ? path.split("/")[2] : undefined}
      />
    );
  else
    page = (
      <main className="page">
        <h1>{text("الصفحة غير موجودة", "Page not found")}</h1>
        <MetalButton onClick={() => navigate("/")}>
          {text("الرئيسية", "Home")}
        </MetalButton>
      </main>
    );
  return (
    <UIContext.Provider
      value={{
        lang,
        theme,
        setLang,
        setTheme,
        path,
        navigate,
        user,
        setUser,
        text,
        speak,
        toast,
      }}
    >
      <a className="skip-link" href="#content">
        {text("تجاوز إلى المحتوى", "Skip to content")}
      </a>
      {path !== "/" && (
        <div className="topbar">
          <button
            className="brand-mini"
            onClick={() => navigate("/")}
            aria-label={text("الرئيسية", "Home")}
          >
            <img src={`/brand/logo-${theme}-192.webp`} alt="VIP" />
          </button>
          <div>
            <button
              className="icon-button"
              onClick={() => setLang(lang === "ar" ? "en" : "ar")}
              aria-label={text("English", "العربية")}
            >
              <Globe size={20} />
              <span>{lang === "ar" ? "EN" : "ع"}</span>
            </button>
            <button
              className="icon-button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={text("تبديل الوضع", "Switch theme")}
            >
              {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
        </div>
      )}
      <div id="content">
        <Suspense fallback={<Busy />}>{page}</Suspense>
        {user && ["/account", "/admin"].includes(path) && (
          <Suspense fallback={null}>
            <PushPermission />
          </Suspense>
        )}
      </div>
      <button
        className="accessibility-button"
        onClick={() => setVoice(!voice)}
        aria-label={text("الصوت والإتاحة", "Voice and accessibility")}
      >
        <Accessibility size={23} />
      </button>
      {voice && (
        <div className="accessibility-popover metal-panel">
          <h2>{text("الصوت والإتاحة", "Voice & accessibility")}</h2>
          <button className="text-button" onClick={voiceNavigation}>
            <Volume2 size={18} />
            {voiceListening
              ? text("أستمع…", "Listening…")
              : text("اختر الصفحة بصوتك", "Navigate by voice")}
          </button>
          <button
            className="text-button"
            onClick={() =>
              speak(
                text(
                  "يمكنك قول البحث أو العينة أو المزايا أو إنشاء موقع. جميع الحقول تتيح النطق والاستماع والتأكيد.",
                  "Say search, demo, features, or create site. Fields support voice input, listening, and confirmation.",
                ),
              )
            }
          >
            {text("استمع للتعليمات", "Listen to instructions")}
          </button>
          <button
            className="text-button"
            onClick={() => {
              speechSynthesis?.cancel();
              setVoice(false);
            }}
          >
            {text("إغلاق وإيقاف الصوت", "Close and stop speech")}
          </button>
        </div>
      )}
      {showInstall && (
        <div className="install-nudge" role="status">
          <img src="/brand/logo-dark-192.webp" alt="" />
          <span>
            {text("VIP أقرب إليك على جهازك", "Keep VIP close on your device")}
          </span>
          <button onClick={requestInstall}>{text("تثبيت", "Install")}</button>
          <button
            aria-label={text("إغلاق", "Close")}
            onClick={() => {
              setShowInstall(false);
              sessionStorage.setItem("vip-install-dismissed", "1");
            }}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {installHelp && (
        <div className="modal-backdrop">
          <section
            className="metal-panel modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-title"
          >
            <h2 id="install-title">{text("تثبيت VIP", "Install VIP")}</h2>
            <p>
              {text(
                "من قائمة المتصفح اختر «إضافة إلى الشاشة الرئيسية» أو «تثبيت التطبيق». يختلف الخيار بحسب الجهاز والمتصفح، ويمكنك الاستمرار على الويب دون تثبيت.",
                "Choose “Add to Home Screen” or “Install app” from your browser menu. Availability varies by device; the website works without installation.",
              )}
            </p>
            <MetalButton onClick={() => setInstallHelp(false)}>
              {text("فهمت", "Got it")}
            </MetalButton>
          </section>
        </div>
      )}
      {cookie && (
        <div
          className="consent-sheet metal-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="consent-title"
        >
          <h2 id="consent-title">
            {text("اختياراتك، بكل وضوح", "Your choices, clearly")}
          </h2>
          <p>
            {text(
              "نحفظ الاختيارات الضرورية لتشغيل الخدمة. المحتوى الخارجي كالفيديو اختياري. لا نفعّل تسويقاً أو تحليلات اختيارية في هذه النسخة.",
              "Necessary preferences support the service. External media such as video is optional. This version does not enable optional marketing or analytics.",
            )}
          </p>
          {custom && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={external}
                onChange={(e) => setExternal(e.target.checked)}
              />
              {text("السماح بالمحتوى الخارجي", "Allow external media")}
            </label>
          )}
          <div className="consent-actions">
            <button onClick={() => consent("all")}>
              {text("قبول الكل", "Accept all")}
            </button>
            <button
              onClick={() => (custom ? consent("partial") : setCustom(true))}
            >
              {custom
                ? text("حفظ الاختيارات", "Save choices")
                : text("تخصيص", "Customize")}
            </button>
            <button onClick={() => consent("essential")}>
              {text("الضروري فقط", "Necessary only")}
            </button>
            <button onClick={() => consent("rejected")}>
              {text("رفض الاختياري", "Reject optional")}
            </button>
          </div>
          <button className="text-button" onClick={() => navigate("/privacy")}>
            {text("سياسة الخصوصية", "Privacy policy")}
          </button>
        </div>
      )}
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
      {path !== "/" && (
        <footer>
          <span>VIP</span>
          <button onClick={() => navigate("/privacy")}>
            {text("الخصوصية", "Privacy")}
          </button>
          <button onClick={() => setCookie(true)}>
            {text("اختيارات الخصوصية", "Privacy choices")}
          </button>
          <a href="mailto:ceo@idvip.app">{text("الدعم", "Support")}</a>
        </footer>
      )}
    </UIContext.Provider>
  );
}
