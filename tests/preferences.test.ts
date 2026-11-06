import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
let jar: Map<string, string>, local: Map<string, string>, writes: string[];
function host(hostname: string) {
  vi.stubGlobal("location", { hostname, protocol: "https:" });
  local = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
  });
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
  jar = new Map();
  writes = [];
  vi.stubGlobal("document", {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(value: string) {
      writes.push(value);
      const pair = value.split(";")[0];
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    },
  });
  host("idvip.app");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("shared non-sensitive preferences", () => {
  it("defaults to no optional consent", async () => {
    const p = await import("../src/client/preferences");
    expect(p.readConsent()).toBeNull();
  });
  it.each(["all", "partial", "essential", "rejected"] as const)(
    "persists and reads %s without another domain prompt",
    async (choice) => {
      const p = await import("../src/client/preferences");
      p.saveConsent(choice, true);
      host("search.idvip.app");
      expect(p.readConsent()).toMatchObject({
        choice,
        external: ["all", "partial"].includes(choice),
      });
      expect(writes[0]).toContain("Domain=idvip.app");
      expect(writes[0]).toContain("Secure");
      expect(writes[0]).toContain("SameSite=Lax");
      expect(writes[0]).not.toMatch(/session|csrf|user_id/);
    },
  );
  it("prefers shared revocation over an old local acceptance", async () => {
    const p = await import("../src/client/preferences");
    p.saveConsent("all");
    const old = local.get("vip-consent")!;
    p.saveConsent("rejected");
    local.set("vip-consent", old);
    expect(p.readConsent()?.external).toBe(false);
  });
  it("migrates a real previous version-1 choice without implicitly accepting", async () => {
    const p = await import("../src/client/preferences");
    local.set(
      "vip-consent",
      JSON.stringify({
        choice: "essential",
        external: true,
        version: 1,
        date: new Date().toISOString(),
      }),
    );
    expect(p.readConsent()).toMatchObject({
      choice: "essential",
      external: false,
      version: 2,
    });
    expect(jar.has("vip-consent")).toBe(true);
  });
  it.each([
    "garbage",
    "{}",
    '{"choice":"all","version":3}',
    JSON.stringify({
      choice: "all",
      external: true,
      version: 1,
      date: "2020-01-01",
    }),
    JSON.stringify({
      choice: "all",
      external: true,
      version: 1,
      date: "2030-01-01",
    }),
  ])(
    "does not treat invalid or expired storage as consent: %s",
    async (value) => {
      const p = await import("../src/client/preferences");
      jar.set("vip-consent", encodeURIComponent(value));
      expect(p.readConsent()).toBeNull();
    },
  );
  it("does not use a live parent-domain cookie on a preview origin", async () => {
    const p = await import("../src/client/preferences");
    host("preview.manus.example");
    p.saveConsent("partial", false);
    expect(writes[0]).not.toContain("Domain=idvip.app");
    expect(p.readConsent()?.external).toBe(false);
  });
  it("keeps the service usable when browser storage is denied", async () => {
    const p = await import("../src/client/preferences");
    vi.stubGlobal("document", {
      get cookie(): string {
        throw Error("denied");
      },
      set cookie(_: string) {
        throw Error("denied");
      },
    });
    vi.stubGlobal("localStorage", {
      getItem() {
        throw Error("denied");
      },
      setItem() {
        throw Error("denied");
      },
    });
    expect(p.readConsent()).toBeNull();
    expect(() => p.saveConsent("rejected")).not.toThrow();
    expect(p.readConsent()?.external).toBe(false);
    expect(() => p.markInstallSeen()).not.toThrow();
    expect(p.installWasSeen()).toBe(true);
  });
});
describe("non-disruptive installation", () => {
  it.each([
    "/search",
    "/features",
    "/blog",
    "/test",
    "/site/alice",
    "/account",
    "/admin",
    "/preview",
    "/privacy",
  ])("never automatically nudges on %s", async (path) => {
    const p = await import("../src/client/preferences");
    expect(p.isPlatformHome(path, "idvip.app")).toBe(false);
    expect(
      p.shouldNudgeInstall(p.isPlatformHome(path, "idvip.app"), false, false),
    ).toBe(false);
  });
  it("excludes direct subdomain homepages and permits only real platform home", async () => {
    const p = await import("../src/client/preferences");
    for (const host of [
      "search.idvip.app",
      "test.idvip.app",
      "auth.idvip.app",
      "alice.idvip.app",
    ])
      expect(p.isPlatformHome("/", host)).toBe(false);
    expect(p.isPlatformHome("/", "idvip.app")).toBe(true);
    expect(p.isPlatformHome("/", "localhost")).toBe(true);
  });
  it("never overlays an open consent sheet or standalone application", async () => {
    const p = await import("../src/client/preferences");
    expect(p.shouldNudgeInstall(true, true, false)).toBe(false);
    expect(p.shouldNudgeInstall(true, false, true)).toBe(false);
    expect(p.shouldNudgeInstall(true, false, false)).toBe(true);
  });
  it("marks the first display before any navigation and shares its dismissal", async () => {
    const p = await import("../src/client/preferences");
    p.markInstallSeen();
    host("test.idvip.app");
    expect(p.shouldNudgeInstall(true, false, false)).toBe(false);
    expect(p.installWasSeen()).toBe(true);
  });
  it("expires the marker after 30 days even with localStorage fallback", async () => {
    const p = await import("../src/client/preferences");
    p.markInstallSeen();
    jar.clear();
    vi.advanceTimersByTime(31 * 86400_000);
    expect(p.installWasSeen()).toBe(false);
  });
  it("the actual app wires home-only consent, a 3-second nudge and manual controls", () => {
    const source = readFileSync(
      new URL("../src/client/App.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("isPlatformHome(initialPath()) && !readConsent()");
    expect(source).toContain(
      "shouldNudgeInstall(isPlatformHome(path), cookie, standalone)",
    );
    expect(source).toContain("setTimeout(() => setShowInstall(false), 3000)");
    expect(source).toContain("saveConsent(choice, external)");
    expect(source).toContain("Privacy choices");
    expect(source).toContain("Install VIP");
    expect(source).not.toContain(
      'sessionStorage.setItem("vip-install-dismissed"',
    );
  });
});
