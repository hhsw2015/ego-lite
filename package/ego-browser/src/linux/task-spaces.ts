/**
 * Linux Task Spaces — per-BrowserContext isolation via CDP
 * `Target.createBrowserContext` / `disposeBrowserContext`.
 *
 * Each Task Space maps to a BrowserContext + its tabs (Targets).
 * Ownership semantics mirror helpers.ts: agent vs user.
 *
 * The registry persists to ~/.cache/ego-lite/task-spaces.json because the
 * Chromium daemon outlives each short-lived CLI process: a space created in
 * one invocation must resolve (and its context be disposable) in the next.
 * CDP goes through cdp-eval's cdp() so message ids share the SDK's pending
 * map instead of colliding with it (lazy import breaks the state.ts cycle,
 * same as snapshot-ax).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type TaskSpace = {
  taskId: string;
  id: number;
  name: string;
  ownership: "agent" | "user" | "agentDelegatedToUser";
  browserContextId?: string;
  createdBy?: string;
};

/** Resolved (not thrown) error shape consumed by helpers.ts' assertNoEgoError. */
type EgoError = { error: string; error_code: string };

type Registry = {
  nextId: number;
  activeId: number | null;
  spaces: TaskSpace[];
};

const REGISTRY_PATH = join(homedir(), ".cache", "ego-lite", "task-spaces.json");

let nextId = 1;
const spaces = new Map<number, TaskSpace>();
let activeId: number | null = null;
let loaded = false;

async function cdp(
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const mod = await import("../cdp-eval.js");
  return (await mod.cdp(method, params)) as Record<string, unknown>;
}

function saveRegistry(): void {
  try {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
    const data: Registry = {
      nextId,
      activeId,
      spaces: [...spaces.values()],
    };
    // ponytail: last-write-wins between concurrent CLI processes; per-space
    // lock files if parallel agents ever corrupt the registry in practice.
    writeFileSync(REGISTRY_PATH, JSON.stringify(data));
  } catch {}
}

/**
 * Load the persisted registry, dropping spaces whose BrowserContext no
 * longer exists (daemon restarted since they were created).
 */
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  let data: Registry | null = null;
  try {
    data = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as Registry;
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.spaces)) return;

  let liveContexts: Set<string> | null = null;
  try {
    const result = await cdp("Target.getBrowserContexts");
    const ids = (result as { browserContextIds?: string[] }).browserContextIds;
    if (Array.isArray(ids)) liveContexts = new Set(ids);
  } catch {}

  for (const space of data.spaces) {
    if (
      space.browserContextId &&
      liveContexts !== null &&
      !liveContexts.has(space.browserContextId)
    ) {
      continue; // context died with a previous daemon
    }
    spaces.set(space.id, space);
  }
  nextId = Math.max(
    data.nextId || 1,
    ...[...spaces.keys()].map((id) => id + 1),
    1,
  );
  activeId =
    data.activeId != null && spaces.has(data.activeId) ? data.activeId : null;
  if (spaces.size !== data.spaces.length) saveRegistry();
}

/** browserContextId of the active space, for listTabs/createTab filtering. */
export async function activeBrowserContextId(): Promise<string | undefined> {
  await ensureLoaded();
  if (activeId == null) return undefined;
  return spaces.get(activeId)?.browserContextId;
}

export class LinuxTaskSpaces {
  constructor(
    private getBridge: () => Promise<{ send: (m: string) => void }>,
  ) {}

  async listTaskSpaces(): Promise<{ taskSpaces: TaskSpace[] }> {
    await ensureLoaded();
    return { taskSpaces: [...spaces.values()] };
  }

  async createTaskSpace(
    name: string,
    profileId?: string,
  ): Promise<TaskSpace | EgoError> {
    // Linux exposes exactly one profile (see listProfiles); reject unknown
    // ids the way the macOS app does instead of silently ignoring them.
    if (profileId !== undefined && profileId !== "default") {
      return {
        error: `Profile not found: ${profileId}`,
        error_code: "EGO_PROFILE_NOT_FOUND",
      };
    }
    await ensureLoaded();
    await this.getBridge();
    const id = nextId++;
    const taskId = name;
    let browserContextId: string | undefined;
    try {
      const created = await cdp("Target.createBrowserContext", {
        disposeOnDetach: false,
      });
      browserContextId = (created as { browserContextId?: string })
        .browserContextId;
      if (browserContextId) {
        // The default tab page-model's waitForCreatedSpaceTab expects.
        await cdp("Target.createTarget", {
          url: "about:blank",
          browserContextId,
        });
      }
    } catch {
      // Isolation unavailable (very old Chrome): space still works, but
      // shares the default profile and listTabs stays unfiltered for it.
    }
    const space: TaskSpace = {
      taskId,
      id,
      name,
      ownership: "agent",
      browserContextId,
      createdBy: "agent",
    };
    spaces.set(id, space);
    activeId = id;
    saveRegistry();
    return space;
  }

  async useTaskSpace(id: number): Promise<void | EgoError> {
    await ensureLoaded();
    const s = spaces.get(id);
    if (!s)
      return {
        error: `task space not found: ${id}`,
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      };
    if (s.ownership === "user") {
      return {
        error: "user control",
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      };
    }
    activeId = id;
    saveRegistry();
  }

  async closeTaskSpace(): Promise<void | EgoError> {
    await ensureLoaded();
    if (activeId == null)
      return {
        error: "no active task space",
        error_code: "EGO_TASK_SPACE_NOT_SELECTED",
      };
    const s = spaces.get(activeId);
    if (s?.browserContextId) {
      try {
        await cdp("Target.disposeBrowserContext", {
          browserContextId: s.browserContextId,
        });
      } catch {}
    }
    spaces.delete(activeId);
    activeId = spaces.size ? [...spaces.keys()][0] : null;
    saveRegistry();
  }

  async claimTaskSpace(
    id: number,
    _name?: string,
  ): Promise<TaskSpace | EgoError> {
    await ensureLoaded();
    const s = spaces.get(id);
    if (!s)
      return {
        error: `task space not found: ${id}`,
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      };
    s.ownership = "agent";
    activeId = id;
    saveRegistry();
    return s;
  }

  async handOffTaskSpace(): Promise<void> {
    await ensureLoaded();
    if (activeId == null) return;
    const s = spaces.get(activeId);
    if (s) {
      s.ownership = "agentDelegatedToUser";
      saveRegistry();
    }
  }

  async takeOverTaskSpace(): Promise<void> {
    await ensureLoaded();
    if (activeId == null) return;
    const s = spaces.get(activeId);
    if (s) {
      s.ownership = "agent";
      saveRegistry();
    }
  }

  async completeTaskSpace(): Promise<void> {
    // task.finish's keep path: the space (and its BrowserContext) survives —
    // the SDK calls closeTaskSpace directly when it wants destruction. Only
    // deselect here.
    await ensureLoaded();
    if (activeId != null) {
      activeId = null;
      saveRegistry();
    }
  }
}
