/**
 * Linux Snapshot — AX-tree snapshot via Accessibility.getFullAXTree
 * with DOM fallback.
 *
 * Produces { content, refs } matching driver/observe.ts shape. Content lines
 * follow the macOS renderer's format — an indented tree of
 * `role "name" [ref=N]` — because snapshot-result.ts compaction and the e2e
 * suite parse that exact metadata syntax, and ref-map keys on refs[].refId.
 * Lazy-imports cdp-eval to break circular import (state->linux->cdp-eval->state).
 */

export interface SnapshotOptions {
  scope?: "only_within_viewport" | "full_page";
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
  maxResultLength?: number;
}

export interface SnapshotResult {
  content: string;
  refs: Array<{
    refId: string;
    backendNodeId: number;
    role?: string;
    name?: string;
  }>;
}

type AxNode = {
  nodeId?: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  ignored?: boolean;
};

// Roles an agent can act on get refs; pure containers/text stay unnumbered
// so snapshots remain compact and refs point at actionable nodes.
const ACTIONABLE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textarea",
  "image",
  "heading",
]);

export class LinuxSnapshot {
  constructor() {}

  async snapshot(opts: SnapshotOptions = {}): Promise<SnapshotResult> {
    const { cdp } = await import("../cdp-eval.js");

    try {
      try {
        await cdp("Accessibility.enable", {});
      } catch {}
      const ax = (await cdp("Accessibility.getFullAXTree", {})) as {
        nodes?: AxNode[];
      };
      if (ax?.nodes?.length) {
        return renderAxTree(ax.nodes, opts);
      }
    } catch {}

    try {
      await cdp("DOM.getDocument", { depth: -1, pierce: true });
      // Use maxResultLength as the single truncation budget (default to 250k to
      // avoid unbounded pages when caller does not pass a limit).
      const limit = opts.maxResultLength ?? 250_000;
      const html: string = (await cdp("Runtime.evaluate", {
        expression: `document.documentElement ? document.documentElement.outerHTML.slice(0, ${limit}) : ''`,
        returnByValue: true,
        awaitPromise: false,
      }).then(
        (r: { result?: { value?: string } }) => r?.result?.value ?? "",
      )) as string;
      let content = html || "(empty page)";
      if (content.length > limit) content = content.slice(0, limit);
      return { content, refs: [] };
    } catch {
      return { content: "(snapshot unavailable)", refs: [] };
    }
  }
}

function renderAxTree(nodes: AxNode[], opts: SnapshotOptions): SnapshotResult {
  const byId = new Map<string, AxNode>();
  for (const n of nodes) if (n.nodeId) byId.set(n.nodeId, n);
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));

  const refs: SnapshotResult["refs"] = [];
  const lines: string[] = [];
  let nextRef = 1;

  const visit = (node: AxNode, depth: number): void => {
    let childDepth = depth;
    if (!node.ignored) {
      const role = node.role?.value ?? "";
      const name = node.name?.value ?? "";
      const backendNodeId = node.backendDOMNodeId;
      const parts = [role || "container"];
      if (name) parts.push(JSON.stringify(name));
      if (backendNodeId != null && ACTIONABLE.has(role)) {
        const refId = String(nextRef++);
        refs.push({ refId, backendNodeId, role, name });
        parts.push(`[ref=${refId}]`);
      }
      lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
      childDepth = depth + 1;
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, childDepth);
    }
  };

  for (const root of roots) visit(root, 0);

  let content = lines.join("\n");
  if (opts.maxResultLength != null && content.length > opts.maxResultLength) {
    content = content.slice(0, opts.maxResultLength);
  }
  return { content, refs };
}
