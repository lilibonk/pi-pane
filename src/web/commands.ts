import type { WorkbenchCommand } from "../protocol/workbench.js";

/** RPC does not parse pi's interactive builtins. Reserve them even while the catalog is unavailable. */
const actions: Record<string, WorkbenchCommand["browserAction"]> = {
  new: "new", resume: "sessions", fork: "tree", model: "model", thinking: "thinking",
  compact: "compact", settings: "settings", session: "status", name: "rename", clone: "clone",
};
const unsupported = ["tree", "scoped-models", "export", "import", "share", "bug", "copy", "changelog", "hotkeys",
  "trust", "login", "logout", "reload", "quit", "debug", "arminsayshi", "dementedelves", "web"];
export function builtinCommand(name: string): WorkbenchCommand | undefined {
  const action = actions[name];
  if (action) return { name, description: "打开对应工作台入口", source: "builtin", available: true, browserAction: action };
  if (!unsupported.includes(name)) return;
  return { name, description: "pi 内置命令", source: "builtin", available: false,
    reason: name === "tree" ? "pi RPC 暂不支持 tree 导航；可查看分支树或从用户消息分叉。" : "交接模式不支持此命令；请先在终端按 Ctrl+C 停止服务。" };
}
export function resolveSlash(draft: string, catalog: readonly WorkbenchCommand[]): { command?: WorkbenchCommand; name: string; args: string } | undefined {
  const slash = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  if (!slash) return;
  const name = slash[1]!;
  // Builtins retain priority over an extension using the same name.
  const reserved = builtinCommand(name);
  const command = reserved ? catalog.find(item => item.name === name && item.source === "builtin") ?? reserved
    : catalog.find(item => item.name === name && item.available) ?? catalog.find(item => item.name === name);
  return { name, args: slash[2] ?? "", command };
}
