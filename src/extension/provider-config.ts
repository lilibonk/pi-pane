import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CUSTOM_MODELS, ProtocolError, insecureAddress, isRecord, validateProvider, type CustomProvider, type ProviderInput } from "../protocol/index.js";
import { configValueKind } from "./config-value.js";
import { withFileLock, writeFileAtomic } from "./file-lock.js";

const MAX_BYTES = 1024 * 1024;
const MAX_PROVIDERS = 128, MAX_MODELS = MAX_CUSTOM_MODELS;
/** The fields of a provider and of a model the form edits. Everything else in an entry is kept as it is. */
const PROVIDER_FIELDS = new Set(["baseUrl", "api", "models", "apiKey"]);
const MODEL_FIELDS = new Set(["id", "name", "contextWindow"]);
const clip = (text: string, length: number): string => text.length <= length ? text : `${text.slice(0, length)}…`;
type Json = Record<string, unknown>;

export interface ProviderFile {
  /** Entries the form can show. Others (not an object) are counted, never touched. */
  providers: Omit<CustomProvider, "key" | "overlay" | "inUse" | "available">[];
  /** Kind of an `apiKey` already in the file, by provider. Only the kind: the value is never resolved. */
  fileKeys: Map<string, "file_literal" | "file_env" | "file_command">;
  revision: string;
  error?: string;
}
/**
 * pi's `models.json`, edited one provider at a time. pi has no interface for writing this file, so
 * the host does it: under a lock, from the file as it is at that moment, replacing it in one rename.
 * Only the named provider's `baseUrl`, `api` and `models` change; every other field of the entry,
 * every other provider and every unknown top-level key is written back as it was read. An `apiKey`
 * in the file is never written, changed or resolved here: keys set from the browser go to pi's auth
 * file through pi's own login.
 */
export class ProviderConfig {
  readonly path: string;
  constructor(agentDir: string) { this.path = join(agentDir, "models.json"); }

  private async text(): Promise<string | undefined> {
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile()) throw new ProtocolError("providers_unreadable", "models.json is not a regular file.");
      if (info.size > MAX_BYTES) throw new ProtocolError("providers_unreadable", "models.json is larger than 1 MiB; edit it in a terminal.");
      return (await file.readFile("utf8")).replace(/^﻿/, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("providers_unreadable", "models.json could not be read.");
    } finally { await file?.close().catch(() => undefined); }
  }
  private parse(text: string | undefined): { document: Json; providers: Json } {
    if (text === undefined || !text.trim()) return { document: {}, providers: {} };
    let document: unknown;
    try { document = JSON.parse(text); } catch (error) { throw new ProtocolError("providers_unreadable", `models.json is not valid JSON: ${clip(error instanceof Error ? error.message : String(error), 160)}`); }
    if (!isRecord(document)) throw new ProtocolError("providers_unreadable", "models.json does not contain an object.");
    if (document.providers !== undefined && !isRecord(document.providers)) throw new ProtocolError("providers_unreadable", "\"providers\" in models.json is not an object.");
    return { document, providers: (document.providers ?? {}) as Json };
  }
  private static revision(text: string | undefined): string { return text === undefined ? "absent" : createHash("sha256").update(text).digest("hex").slice(0, 32); }
  private static view(id: string, entry: Json): ProviderFile["providers"][number] {
    const models = Array.isArray(entry.models) ? entry.models.filter(isRecord) : [];
    const insecure = insecureAddress(String(entry.baseUrl));
    return {
      id: clip(id, 128), api: typeof entry.api === "string" ? clip(entry.api, 64) : "", baseUrl: typeof entry.baseUrl === "string" ? clip(entry.baseUrl, 2048) : "",
      models: models.slice(0, MAX_MODELS).filter(model => typeof model.id === "string").map(model => ({ id: clip(model.id as string, 256),
        ...(typeof model.name === "string" ? { name: clip(model.name, 256) } : {}), ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}) })),
      extra: Object.keys(entry).filter(key => !PROVIDER_FIELDS.has(key)).slice(0, 32).map(key => clip(key, 64)),
      modelExtras: models.filter(model => Object.keys(model).some(key => !MODEL_FIELDS.has(key))).length, insecure,
    };
  }
  /** The file as the form may show it. A file that cannot be parsed yields no providers and the reason. */
  async read(): Promise<ProviderFile> {
    let text: string | undefined;
    try { text = await this.text(); } catch (error) { return { providers: [], fileKeys: new Map(), revision: "unreadable", error: clip((error as Error).message, 300) }; }
    const revision = ProviderConfig.revision(text);
    let providers: Json;
    try { ({ providers } = this.parse(text)); } catch (error) { return { providers: [], fileKeys: new Map(), revision, error: clip((error as Error).message, 300) }; }
    const entries = Object.entries(providers).filter((pair): pair is [string, Json] => isRecord(pair[1])).slice(0, MAX_PROVIDERS);
    const fileKeys = new Map<string, "file_literal" | "file_env" | "file_command">();
    for (const [id, entry] of entries) if (typeof entry.apiKey === "string" && entry.apiKey) {
      const kind = configValueKind(entry.apiKey);
      fileKeys.set(id, kind === "command" ? "file_command" : kind === "environment" ? "file_env" : "file_literal");
    }
    return { providers: entries.map(([id, entry]) => ProviderConfig.view(id, entry)), fileKeys, revision };
  }
  /** Provider names in the file. Empty when it cannot be parsed. */
  async ids(): Promise<Set<string>> { return new Set((await this.read()).providers.map(provider => provider.id)); }

  /**
   * Reads, changes and replaces the file under the lock. `expected` is the revision the page edited
   * from: a different file means another page, another pi or an editor changed it, and nothing is written.
   */
  private change(expected: string, edit: (providers: Json) => void): Promise<string> {
    return withFileLock(this.path, async () => {
      const text = await this.text();
      if (ProviderConfig.revision(text) !== expected) throw new ProtocolError("stale_providers", "models.json was changed elsewhere. The list has been read again; check it and repeat the change if it is still needed.");
      const { document, providers } = this.parse(text); // an unreadable file is refused here and left as it is
      edit(providers);
      document.providers = providers;
      const next = `${JSON.stringify(document, null, 2)}\n`;
      const mode = await stat(this.path).then(info => info.mode & 0o777, () => 0o600);
      try { await writeFileAtomic(this.path, next, mode); }
      catch (error) { throw new ProtocolError("save_failed", `models.json could not be written: ${clip(error instanceof Error ? error.message : String(error), 200)}`); }
      // Confirmed from disk, like every other save: what is there now is what was meant to be written.
      const written = await this.text().catch(() => undefined);
      if (written !== next) throw new ProtocolError("save_unconfirmed", "models.json does not show the change. Another program may have written it at the same moment.");
      return ProviderConfig.revision(next);
    });
  }
  /** Adds a provider, or changes the form's fields of an existing one. `reserved` are names that mean something else to pi. */
  async save(input: ProviderInput, expected: string, create: boolean, reserved: ReadonlySet<string>): Promise<{ id: string; revision: string; insecure: boolean }> {
    const old = (await this.read()).providers.find(provider => provider.id === input.id.trim());
    const valid = validateProvider(input, old ? { api: old.api } : undefined);
    if (reserved.has(valid.id)) throw create
      ? new ProtocolError("provider_name_taken", "This name belongs to one of pi's own providers or to one an extension provides. An entry with it would change that provider instead of adding one; choose another name.", "id")
      : new ProtocolError("provider_overlay", "This entry changes one of pi's own providers. It can only be edited in models.json itself.");
    const revision = await this.change(expected, providers => {
      const old = providers[valid.id];
      if (create && old !== undefined) throw new ProtocolError("provider_exists", "A provider with this name already exists.", "id");
      if (!create && !isRecord(old)) throw new ProtocolError("provider_missing", "This provider is no longer in models.json.");
      const entry: Json = isRecord(old) ? old : {};
      const before = new Map((Array.isArray(entry.models) ? entry.models.filter(isRecord) : []).map(model => [model.id, model] as const));
      entry.baseUrl = valid.baseUrl; entry.api = valid.api;
      entry.models = valid.models.map(model => {
        // A model keeps whatever else was configured for it (input types, limits, sampling); only the form's fields change.
        const kept: Json = { ...(before.get(model.id) ?? {}), id: model.id };
        if (model.name !== undefined) kept.name = model.name; else delete kept.name;
        if (model.contextWindow !== undefined) kept.contextWindow = model.contextWindow; else delete kept.contextWindow;
        return kept;
      });
      if (Object.keys(providers).length >= MAX_PROVIDERS && old === undefined) throw new ProtocolError("provider_limit", `models.json already has ${MAX_PROVIDERS} providers.`);
      providers[valid.id] = entry;
    });
    return { id: valid.id, revision, insecure: valid.insecure };
  }
  async remove(id: string, expected: string, reserved: ReadonlySet<string>): Promise<{ revision: string }> {
    if (reserved.has(id)) throw new ProtocolError("provider_overlay", "This entry changes one of pi's own providers. It can only be removed in models.json itself.");
    return { revision: await this.change(expected, providers => {
      if (!Object.hasOwn(providers, id)) throw new ProtocolError("provider_missing", "This provider is no longer in models.json.");
      delete providers[id];
    }) };
  }
}
