import { isRecord, ProtocolError } from "../protocol/index.js";

/** User-owned settings are read through pi.getSettings(); this extension never writes them. */
export interface PaneSettings { host?: string; port?: number; noOpen?: boolean }
export function readPaneSettings(settings: unknown): PaneSettings {
  if (!isRecord(settings) || settings.piPane === undefined) return {};
  const config = settings.piPane;
  if (!isRecord(config)) throw new ProtocolError("invalid_config", "settings.piPane must be an object.");
  const unknown = Object.keys(config).filter((key) => !["host", "port", "noOpen"].includes(key));
  if (unknown.length) throw new ProtocolError("invalid_config", `Unsupported piPane setting: ${unknown.join(", ")}`);
  if (config.host !== undefined && (typeof config.host !== "string" || !["127.0.0.1", "localhost", "::1"].includes(config.host)))
    throw new ProtocolError("invalid_config", "piPane.host must be a loopback address until external access is supported.");
  if (config.port !== undefined && (typeof config.port !== "number" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535))
    throw new ProtocolError("invalid_config", "piPane.port must be an integer between 1 and 65535.");
  if (config.noOpen !== undefined && typeof config.noOpen !== "boolean")
    throw new ProtocolError("invalid_config", "piPane.noOpen must be boolean.");
  return { ...(config.host !== undefined ? { host: String(config.host) } : {}),
    ...(config.port !== undefined ? { port: config.port as number } : {}),
    ...(config.noOpen !== undefined ? { noOpen: config.noOpen as boolean } : {}) };
}

/** Surface a clear downgrade before constructing a Bridge or listening socket. */
export function missingHostCapabilities(pi: unknown, ctx: unknown): string[] {
  const roots: Record<string, unknown> = { pi, ctx };
  const functions = [
    "pi.getSettings", "pi.getThinkingLevel", "pi.setThinkingLevel", "pi.setModel", "pi.sendUserMessage",
    "ctx.isIdle", "ctx.hasPendingMessages", "ctx.abort", "ctx.compact",
    "ctx.sessionManager.getSessionId", "ctx.sessionManager.getSessionName", "ctx.sessionManager.getLeafId", "ctx.sessionManager.getBranch",
    "ctx.modelRegistry.getAvailable", "ctx.modelRegistry.find", "ctx.ui.setStatus",
  ];
  const missing: string[] = [];
  for (const path of functions) {
    let value: unknown = roots;
    try { for (const part of path.split(".")) value = isRecord(value) ? value[part] : undefined; }
    catch { value = undefined; }
    if (typeof value !== "function") missing.push(path);
  }
  try {
    const theme = (ctx as { ui?: { theme?: { colors?: unknown; appearance?: unknown } } } | undefined)?.ui?.theme;
    if (!theme || !isRecord(theme.colors) || !["light", "dark"].includes(String(theme.appearance))) missing.push("ctx.ui.theme.colors/appearance");
  } catch { missing.push("ctx.ui.theme.colors/appearance"); }
  return missing;
}
