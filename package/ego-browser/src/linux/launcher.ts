/**
 * Linux Chrome launcher — spawns google-chrome with an ephemeral
 * remote-debugging port, per-TaskSpace browser contexts, and a per-user
 * daemon cache at ~/.cache/ego-lite/.
 *
 * Activated via `EGO_LINUX=1` at startup; installEgoLinux wires all four
 * linux/ modules into globalThis.ego.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readlink, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LauncherOptions {
  /** Whether to start in headless mode (default: false). */
  headless?: boolean;
  /**
   * One of `new` (default), `old`, or `false`.
   *   `new`  → --headless=new (new headless mode, compositor-backed)
   *   `old`  → --headless (old headless mode)
   *   `false`→ skip headless flags entirely
   */
  headlessMode?: "new" | "old" | false;
  /** Custom Chrome binary path. Defaults to `/usr/bin/google-chrome`. */
  executablePath?: string;
  /** Extra CLI args passed to Chrome. */
  args?: string[];
}

export interface ChromeInstance {
  pid: number;
  port: number;
  wsUrl: string;
  process: ChildProcess;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR = join(homedir(), ".cache", "ego-lite");
// Same candidate order as hasChrome() in index.ts — EGO_CHROME_BIN wins,
// then google-chrome variants, then chromium. hasChrome() accepting a binary
// that launchChrome() cannot resolve would activate then fail to spawn.
const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
];
function defaultExecutable(): string {
  const envBin = process.env.EGO_CHROME_BIN;
  if (envBin && existsSync(envBin)) return envBin;
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return CHROME_CANDIDATES[0];
}
const SPAWN_TIMEOUT_MS = 15_000;
const PORT_REGEX = /DevTools listening on ws:\/\/[^:]+:(\d+)/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the remote-debugging port from Chrome's stderr. */
function extractPort(stderr: string): number | null {
  const match = PORT_REGEX.exec(stderr);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Chrome's `--user-data-dir` uses a `SingletonLock` symlink (target
 * `<hostname>-<pid>`) to detect a running instance for that profile. If a
 * prior daemon was killed uncleanly (e.g. SIGKILL, or the parent process
 * dying before its exit handlers ran), the lock can outlive it — the next
 * launch against the same daemonised profile dir then stalls waiting on a
 * process that no longer exists, tripping SPAWN_TIMEOUT_MS. Clear the lock
 * up front when the pid it names is no longer alive.
 */
async function clearStaleSingletonLock(profileDir: string): Promise<void> {
  const lockPath = join(profileDir, "SingletonLock");
  let target: string;
  try {
    target = await readlink(lockPath);
  } catch {
    return;
  }
  const match = /-(\d+)$/.exec(target);
  const pid = match ? Number(match[1]) : NaN;
  if (Number.isFinite(pid) && isProcessAlive(pid)) return;
  await Promise.all(
    ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((name) =>
      rm(join(profileDir, name), { force: true }).catch(() => {}),
    ),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a Chrome instance configured for CDP automation.
 *
 * Flags applied:
 *   --remote-debugging-port=0 (ephemeral, kernel-assigned)
 *   --ozone-platform-hint=auto  --enable-features=UseOzonePlatform
 *   --no-first-run  --disable-dev-shm-usage
 *   --user-data-dir=<CACHE_DIR>/chrome-profile  (isolated, daemonised)
 */
export async function launchChrome(
  options: LauncherOptions = {},
): Promise<ChromeInstance> {
  await mkdir(CACHE_DIR, { recursive: true });

  const executable = options.executablePath ?? defaultExecutable();
  const profileDir = join(CACHE_DIR, "chrome-profile");
  await clearStaleSingletonLock(profileDir);

  // --remote-debugging-port=0 tells Chrome to pick a free ephemeral port
  // itself and write it to stderr as `DevTools listening on ws://host:<PORT>/...`.
  const args: string[] = [
    `--remote-debugging-port=0`,
    "--ozone-platform-hint=auto",
    "--enable-features=UseOzonePlatform",
    "--no-first-run",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profileDir}`,
    "--disable-gpu-sandbox", // common CI/Linux compat
    "--no-sandbox", // required in many container/CI envs
    ...(options.args ?? []),
  ];

  // headless
  if (options.headless !== false) {
    const mode = options.headlessMode ?? "new";
    if (mode === "new") {
      args.push("--headless=new");
    } else if (mode === "old") {
      args.push("--headless");
    }
  }

  return new Promise<ChromeInstance>((resolve, reject) => {
    // Detached: the daemon must outlive the short-lived CLI process so later
    // invocations (and the user watching a headful window) can reuse it.
    const child = spawn(executable, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      env: { ...process.env },
    });

    let stderr = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      child.kill("SIGTERM");
      reject(
        new Error(
          `Chrome did not produce a DevTools port within ${SPAWN_TIMEOUT_MS}ms`,
        ),
      );
    }, SPAWN_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      if (resolved) return;
      const found = extractPort(stderr);
      if (found !== null) {
        resolved = true;
        clearTimeout(timer);
        // Stop reading stderr and drop the child from this process's ref
        // count: the daemon keeps running after the CLI exits, and later
        // invocations find it via DevToolsActivePort.
        child.stderr?.destroy();
        child.unref();
        resolve({
          pid: child.pid!,
          port: found,
          wsUrl: `ws://127.0.0.1:${found}`,
          process: child,
        });
      }
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Chrome exited with code ${code} before DevTools port was available.\n${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

/**
 * Kill the Chrome daemon process.
 * SIGTERM first; SIGKILL after 3 s.
 */
export function killChrome(instance: ChromeInstance): void {
  const { process: proc } = instance;
  if (proc.exitCode != null || proc.killed) return;
  proc.kill("SIGTERM");
  setTimeout(() => {
    try {
      if (proc.exitCode == null) proc.kill("SIGKILL");
    } catch {
      // best-effort
    }
  }, 3000);
}
