import { CUSTOM_PROVIDER_APIS, type CustomModel } from "./host.js";
import { ProtocolError } from "./index.js";

/** What the provider form submits. The key is not part of it: it is set through pi's login. */
export interface ProviderInput { id: string; api: string; baseUrl: string; models: CustomModel[] }
export const MAX_CUSTOM_MODELS = 64;
const clip = (text: string, length: number): string => text.length <= length ? text : `${text.slice(0, length)}…`;
const loopback = (host: string): boolean => {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name.endsWith(".localhost") || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name);
};
/** Plain http to a machine other than this one: requests, and the key with them, travel unencrypted. */
export function insecureAddress(address: string): boolean {
  try { const url = new URL(address); return url.protocol === "http:" && !loopback(url.hostname); } catch { return false; }
}
/**
 * Normalizes what the form sent, or refuses with the field to correct (`models.2.id` names a row).
 * The page uses it to point at the field; the host runs it again and decides. Nothing is contacted
 * to check an address. `existing` is the entry being edited: a protocol the form does not offer is
 * accepted only where the entry already has it.
 */
export function validateProvider(input: ProviderInput, existing?: { api?: unknown }): ProviderInput & { insecure: boolean } {
  const issue = (field: string, message: string): never => { throw new ProtocolError("invalid_provider", message, field); };
  const id = input.id.trim();
  // The name becomes a key of pi's auth file and part of `provider/model`: no slash, no spaces, nothing a path or flag could be mistaken for.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) issue("id", "The name must start with a letter or digit and use only letters, digits, dots, hyphens and underscores (at most 64).");
  if (!(CUSTOM_PROVIDER_APIS as readonly string[]).includes(input.api) && input.api !== existing?.api) issue("api", "Choose one of the listed API protocols.");
  let url: URL | undefined;
  try { url = new URL(input.baseUrl.trim()); } catch { issue("baseUrl", "Enter a complete address, such as https://example.com/v1."); }
  if (url!.protocol !== "http:" && url!.protocol !== "https:") issue("baseUrl", "The address must start with http:// or https://.");
  if (url!.username || url!.password) issue("baseUrl", "Do not put a user name or password in the address; set the key separately.");
  if (!url!.hostname) issue("baseUrl", "The address has no host.");
  if (!input.models.length) issue("models", "Add at least one model.");
  if (input.models.length > MAX_CUSTOM_MODELS) issue("models", `At most ${MAX_CUSTOM_MODELS} models.`);
  const seen = new Set<string>();
  const models = input.models.map((model, index): CustomModel => {
    const modelId = model.id.trim(), name = model.name?.trim();
    if (!modelId || modelId.length > 200 || /[\0-\x1f]/.test(modelId)) issue(`models.${index}.id`, "Each model needs an ID of at most 200 characters.");
    if (seen.has(modelId)) issue(`models.${index}.id`, `The model "${clip(modelId, 60)}" is listed twice.`);
    seen.add(modelId);
    if (name !== undefined && (name.length > 200 || /[\0-\x1f]/.test(name))) issue(`models.${index}.name`, "A display name has at most 200 characters.");
    if (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || model.contextWindow > 100_000_000))
      issue(`models.${index}.contextWindow`, "The context length must be a whole number greater than zero.");
    return { id: modelId, ...(name ? { name } : {}), ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}) };
  });
  return { id, api: input.api, baseUrl: input.baseUrl.trim(), models, insecure: insecureAddress(input.baseUrl.trim()) };
}
