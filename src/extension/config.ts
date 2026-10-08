import { isRecord, ProtocolError } from "../protocol/index.js";

/** User-owned settings are read through pi.getSettings(); this extension never writes them. */
export interface PaneSettings {
  host?: string;
  port?: number;
  noOpen?: boolean;
  /** External access (§9.1): https://host[:port] that browsers use. The password comes only from PI_PANE_PASSWORD. */
  publicOrigin?: string;
  tlsCert?: string;
  tlsKey?: string;
  proxy?: boolean;
}
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
const STRING_KEYS = ["host", "publicOrigin", "tlsCert", "tlsKey"] as const;
const BOOLEAN_KEYS = ["noOpen", "proxy"] as const;
export function readPaneSettings(settings: unknown): PaneSettings {
  if (!isRecord(settings) || settings.piPane === undefined) return {};
  const config = settings.piPane;
  if (!isRecord(config)) throw new ProtocolError("invalid_config", "settings.piPane must be an object.");
  const unknown = Object.keys(config).filter((key) => !["port", ...STRING_KEYS, ...BOOLEAN_KEYS].includes(key));
  if (unknown.length) throw new ProtocolError("invalid_config", `Unsupported piPane setting: ${unknown.join(", ")}`);
  const result: PaneSettings = {};
  for (const key of STRING_KEYS) {
    if (config[key] === undefined) continue;
    if (typeof config[key] !== "string" || !config[key]) throw new ProtocolError("invalid_config", `piPane.${key} must be a nonempty string.`);
    result[key] = config[key] as string;
  }
  for (const key of BOOLEAN_KEYS) {
    if (config[key] === undefined) continue;
    if (typeof config[key] !== "boolean") throw new ProtocolError("invalid_config", `piPane.${key} must be boolean.`);
    result[key] = config[key] as boolean;
  }
  if (config.port !== undefined && (typeof config.port !== "number" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535))
    throw new ProtocolError("invalid_config", "piPane.port must be an integer between 1 and 65535.");
  if (config.port !== undefined) result.port = config.port as number;
  if (result.host && !LOOPBACK.includes(result.host) && !result.publicOrigin)
    throw new ProtocolError("invalid_config", "piPane.host may be non-loopback only together with publicOrigin and TLS or proxy settings.");
  return result;
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
