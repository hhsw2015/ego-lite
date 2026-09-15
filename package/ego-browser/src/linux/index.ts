/**
 * Linux polyfill entrypoint — `src/linux/index.ts`
 *
 * Installs a `globalThis.ego` polyfill on Linux that routes all browser
 * work through a local Chrome instance via CDP. Zero cost on macOS.
 *
 * Activation:
 *   - `EGO_LINUX=1` forces activation (explicit opt-in).
 *   - Otherwise on Linux: requires `google-chrome` binary to auto-activate.
 *   - Unit tests: set `EGO_LINUX=0` or `CI=1` to suppress (helpers.test.mjs
 *     mocks cdpOverride so chrome must NOT be spawned during tests).
 *   - macOS: never auto-activates.
 *
 * Wiring: imported by `src/state.ts` (side-effect) so activation happens
 * before any helper is evaluated. To avoid breaking tests, activation is
 * deferred to the first `globalThis.ego` access when not already present.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { connectLinuxBridge } from "./bridge.js";
import { launchChrome, type ChromeInstance } from "./launcher.js";
import { LinuxSnapshot } from "./snapshot-ax.js";
import { activeBrowserContextId, LinuxTaskSpaces } from "./task-spaces.js";

const WS_PORT = Number(process.env.EGO_LINUX_PORT ?? 9222);

// A daemon launched with --remote-debugging-port=0 records its ephemeral port
// in <profile>/DevToolsActivePort. Reading it lets a fresh CLI process reuse
// the running daemon instead of probing only :9222, failing, and then
// stalling on the daemon's SingletonLock while trying to relaunch.
function daemonPort(): number | null {
  try {
    const portFile = join(
      homedir(),
      ".cache",
      "ego-lite",
      "chrome-profile",
      "DevToolsActivePort",
    );
    const port = Number(readFileSync(portFile, "utf-8").split("\n")[0]);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

let instance: ChromeInstance | null = null;
let bridge: { send: (m: string) => void; close: () => void } | null = null;
let bridgePromise: Promise<{ send: (m: string) => void }> | null = null;
let installed = false;

function hasChrome(): boolean {
  const envBin = process.env.EGO_CHROME_BIN;
  if (envBin && existsSync(envBin)) return true;
  const bin = "/usr/bin/google-chrome";
  if (existsSync(bin)) return true;
  // Google's .deb installs as google-chrome-stable; npx installs via skills use PATH
  for (const p of [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ]) {
    if (existsSync(p)) return true;
  }
  return false;
}

function shouldActivate(): boolean {
  if (process.env.EGO_LINUX === "0") return false;
  if (process.env.EGO_LINUX === "1") return true;
  // Suppress during unit tests — helpers.test.mjs uses cdpOverride
  if (process.env.CI && process.env.EGO_LINUX !== "1") return false;
  if (process.platform !== "linux") return false;
  return hasChrome();
}

function onBridgeMessage(data: string): void {
  const cb = (globalThis.ego as Record<string, unknown>)?.onCDPMessage as
    | ((msg: string) => void)
    | undefined;
  if (typeof cb === "function") cb(data);
}

let shutdownCleanup: (() => void) | null = null;

function onBridgeClose(): void {
  // The WS died (crash, kill, network blip). Drop both handles so the next
  // ensureBridge() call respawns cleanly instead of reusing a dead bridge
  // forever or leaking the old Chrome process.
  bridge = null;
  bridgePromise = null;
  if (shutdownCleanup) {
    process.removeListener("exit", shutdownCleanup);
    process.removeListener(
      "SIGINT",
      shutdownCleanup as unknown as NodeJS.SignalsListener,
    );
    process.removeListener(
      "SIGTERM",
      shutdownCleanup as unknown as NodeJS.SignalsListener,
    );
    shutdownCleanup = null;
  }
  // Drop the handle without killing the daemon: a WS close is usually this
  // CLI process exiting, and the daemon must survive for the next invocation.
  instance = null;
}

async function ensureBridge(): Promise<{ send: (m: string) => void }> {
  if (bridge) return bridge;
  if (bridgePromise) return bridgePromise;
  bridgePromise = (async (): Promise<{ send: (m: string) => void }> => {
    for (const port of [daemonPort(), WS_PORT]) {
      if (port === null) continue;
      try {
        bridge = await connectLinuxBridge({
          port,
          timeoutMs: 1500,
          onMessage: onBridgeMessage,
          onClose: onBridgeClose,
        });
        return bridge;
      } catch {}
    }
    // EGO_HEADFUL=1 opens a visible Chromium window so the user can watch and
    // take over agent work (closest Linux analog to ego lite's Space UI).
    instance = await launchChrome({
      headless: process.env.EGO_HEADFUL !== "1",
    });
    await new Promise((r) => setTimeout(r, 600));
    bridge = await connectLinuxBridge({
      port: instance.port,
      timeoutMs: 5000,
      onMessage: onBridgeMessage,
      onClose: onBridgeClose,
    });
    const cleanup = () => {
      // Close only this process's WS bridge. The Chromium daemon stays up so
      // subsequent CLI invocations (and a headful window the user is
      // watching) survive; DevToolsActivePort lets them reconnect.
      try {
        bridge?.close();
      } catch {}
    };
    shutdownCleanup = cleanup;
    process.once("exit", cleanup);
    process.once("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });
    return bridge;
  })();
  try {
    return await bridgePromise;
  } catch (e) {
    bridgePromise = null;
    throw e;
  }
}

export async function installEgoLinux(): Promise<void> {
  if (installed) return;
  if (!shouldActivate()) return;

  const taskSpaces = new LinuxTaskSpaces(() => ensureBridge());
  const snapshot = new LinuxSnapshot();

  const ego: Record<string, unknown> = {
    sendCDPMessage(payload: string) {
      void ensureBridge()
        .then((b) => b.send(payload))
        .catch((e) => {
          const cb = (globalThis.ego as Record<string, unknown>)
            ?.onSendCDPMessageError as
            | ((msg: string, code?: string) => void)
            | undefined;
          if (typeof cb === "function")
            cb(e.message ?? String(e), "EGO_CDP_SEND_FAILED");
        });
    },
    onCDPMessage: null as unknown as (msg: string) => void,
    onSendCDPMessageError: null as unknown as (
      msg: string,
      code?: string,
    ) => void,

    async listTabs() {
      try {
        await ensureBridge();
      } catch {}
      try {
        // Target.getTargets (browser endpoint) carries browserContextId,
        // which the HTTP /json list does not expose reliably. Filtering by
        // the active space's context is what isolates spaces from each
        // other and from the user's own tabs.
        const { cdp } = await import("../cdp-eval.js");
        const result = (await cdp("Target.getTargets", {})) as {
          targetInfos?: Array<{
            targetId: string;
            type?: string;
            title?: string;
            url?: string;
            browserContextId?: string;
          }>;
        };
        const contextId = await activeBrowserContextId();
        // Chrome's HTTP /json is ordered by recency of activation; use it to
        // mark the frontmost page so currentTab() (tab.active || tabs[0])
        // resolves the most recently activated tab, not CDP's stable order.
        let activationOrder: string[] = [];
        try {
          const { request } = await import("node:http");
          const port = instance?.port ?? daemonPort() ?? WS_PORT;
          activationOrder = await new Promise<string[]>((resolve) => {
            const req = request(`http://127.0.0.1:${port}/json`, (res) => {
              let d = "";
              res.on("data", (c: Buffer) => (d += c.toString()));
              res.on("end", () => {
                try {
                  const arr = JSON.parse(d) as Array<{ id?: string }>;
                  resolve(arr.map((t) => t.id ?? ""));
                } catch {
                  resolve([]);
                }
              });
            });
            req.on("error", () => resolve([]));
            req.end();
          });
        } catch {}
        const rank = new Map(activationOrder.map((id, i) => [id, i]));
        const tabs = (result.targetInfos ?? [])
          .filter((t) => t.type === "page")
          .filter(
            (t) => contextId === undefined || t.browserContextId === contextId,
          )
          .sort(
            (a, b) =>
              (rank.get(a.targetId) ?? Infinity) -
              (rank.get(b.targetId) ?? Infinity),
          )
          .map((t, index) => ({
            targetId: t.targetId,
            title: t.title ?? "",
            url: t.url ?? "",
            active: index === 0,
          }));
        return { tabs };
      } catch {}
      return { tabs: [] };
    },
    async createTab(url: string) {
      try {
        await ensureBridge();
        const { cdp } = await import("../cdp-eval.js");
        const contextId = await activeBrowserContextId();
        const created = (await cdp("Target.createTarget", {
          url: url || "about:blank",
          ...(contextId ? { browserContextId: contextId } : {}),
        })) as { targetId?: string };
        return { targetId: created.targetId ?? "" };
      } catch {
        return { targetId: "" };
      }
    },
    async snapshot(opts: unknown) {
      return snapshot.snapshot(opts as never);
    },
    async listTaskSpaces() {
      return taskSpaces.listTaskSpaces();
    },
    async createTaskSpace(name: string, profileId?: string) {
      return taskSpaces.createTaskSpace(name, profileId);
    },
    async useTaskSpace(id: number) {
      return taskSpaces.useTaskSpace(id);
    },
    async closeTaskSpace() {
      return taskSpaces.closeTaskSpace();
    },
    async claimTaskSpace(id: number, name?: string) {
      return taskSpaces.claimTaskSpace(id, name);
    },
    async handOffTaskSpace() {
      return taskSpaces.handOffTaskSpace();
    },
    async takeOverTaskSpace() {
      return taskSpaces.takeOverTaskSpace();
    },
    async completeTaskSpace() {
      return taskSpaces.completeTaskSpace();
    },
    getBrowserVersion() {
      return null;
    },
    async listProfiles() {
      // Linux drives one Chromium profile (the daemonised chrome-profile);
      // per-space isolation comes from BrowserContexts, not profiles.
      return {
        profiles: [{ id: "default", name: "Default", isDefault: true }],
      };
    },
  };

  if (!globalThis.ego) {
    (globalThis as Record<string, unknown>).ego = ego;
  }
  installed = true;
}

export function isLinuxEgoInstalled(): boolean {
  return installed;
}

// Do NOT auto-activate at import time when CI=1 or EGO_LINUX=0 —
// that would spawn Chrome during unit tests (helpers.test.mjs mocks
// cdpOverride and must NOT trigger launcher). Manual callers can
// `await installEgoLinux()` or rely on helpers.ts which triggers it lazily.
// Eager activation only when explicitly opted in via EGO_LINUX=1.
if (process.env.EGO_LINUX === "1") {
  void installEgoLinux().catch(() => {});
}
