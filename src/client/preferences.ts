export type ConsentChoice = "all" | "partial" | "essential" | "rejected";
export interface ConsentPreference {
  choice: ConsentChoice;
  external: boolean;
  version: 2;
  date: string;
}
const CONSENT_KEY = "vip-consent";
const INSTALL_KEY = "vip-install-seen";
const CONSENT_DAYS = 180;
const INSTALL_DAYS = 30;
let memoryConsent: ConsentPreference | null = null;
let memoryInstall: string | null = null;

function cookieValue(key: string): string | null {
  try {
    const entry = document.cookie
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(key + "="));
    return entry ? decodeURIComponent(entry.slice(key.length + 1)) : null;
  } catch {
    return null;
  }
}
function localValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function persist(key: string, value: string, days: number): void {
  try {
    const host = location.hostname.toLowerCase();
    const domain =
      host === "idvip.app" || host.endsWith(".idvip.app")
        ? "; Domain=idvip.app"
        : "";
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; SameSite=Lax${secure}${domain}`;
  } catch {
    /* Storage-blocking must not prevent using the application. */
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    /* In-memory fallback remains. */
  }
}
function parseConsent(raw: string | null): ConsentPreference | null {
  if (!raw || raw.length > 1200) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const record = value as Record<string, unknown>;
    if (
      !["all", "partial", "essential", "rejected"].includes(
        String(record.choice),
      )
    )
      return null;
    if (record.version !== 1 && record.version !== 2) return null;
    if (typeof record.date !== "string") return null;
    const age = Date.now() - Date.parse(record.date);
    if (
      !Number.isFinite(age) ||
      age < -60_000 ||
      age > CONSENT_DAYS * 86400_000
    )
      return null;
    const choice = record.choice as ConsentChoice;
    return {
      choice,
      external:
        choice === "all" || (choice === "partial" && record.external === true),
      version: 2,
      date: record.date,
    };
  } catch {
    return null;
  }
}
/** A shared cookie is only a preference, never authentication or authorization. */
export function readConsent(): ConsentPreference | null {
  const shared = parseConsent(cookieValue(CONSENT_KEY));
  if (shared) return shared;
  const legacy = parseConsent(localValue(CONSENT_KEY));
  if (legacy) {
    persist(CONSENT_KEY, JSON.stringify(legacy), CONSENT_DAYS);
    return legacy;
  }
  return memoryConsent;
}
export function saveConsent(
  choice: ConsentChoice,
  allowExternal = false,
): ConsentPreference {
  const result: ConsentPreference = {
    choice,
    external: choice === "all" || (choice === "partial" && allowExternal),
    version: 2,
    date: new Date().toISOString(),
  };
  memoryConsent = result;
  persist(CONSENT_KEY, JSON.stringify(result), CONSENT_DAYS);
  return result;
}
function recentInstall(value: string | null): boolean {
  if (!value) return false;
  const age = Date.now() - Number(value);
  return (
    Number.isFinite(age) && age >= -60_000 && age < INSTALL_DAYS * 86400_000
  );
}
export function installWasSeen(): boolean {
  return (
    recentInstall(cookieValue(INSTALL_KEY)) ||
    recentInstall(localValue(INSTALL_KEY)) ||
    recentInstall(memoryInstall)
  );
}
export function markInstallSeen(): void {
  memoryInstall = String(Date.now());
  persist(INSTALL_KEY, memoryInstall, INSTALL_DAYS);
}
export function isPlatformHome(
  path: string,
  hostname = location.hostname,
): boolean {
  const live = hostname === "idvip.app" || hostname.endsWith(".idvip.app");
  return path === "/" && (!live || hostname === "idvip.app");
}
export function shouldNudgeInstall(
  home: boolean,
  consentOpen: boolean,
  standalone: boolean,
): boolean {
  return home && !consentOpen && !standalone && !installWasSeen();
}
