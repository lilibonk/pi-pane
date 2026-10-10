import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { ProtocolError, type AccountMethod, type AccountNotice, type AccountOperation, type AccountProvider, type AccountStep } from "../protocol/index.js";
import { configValueKind, literalConfigValue } from "./config-value.js";

/** The part of pi's public ModelRuntime this controller uses. Tests supply a scripted one. */
export interface AuthRuntime {
  getProviders(): readonly { id: string; name: string; auth?: { apiKey?: { name: string; login?: unknown }; oauth?: { name: string } } }[];
  getModels(providerId: string): readonly unknown[];
  listCredentials(): Promise<readonly { providerId: string; type: "api_key" | "oauth" }[]>;
  login(providerId: string, type: "api_key" | "oauth", interaction: AuthInteraction): Promise<{ type: string; key?: string }>;
  logout(providerId: string): Promise<void>;
}
export interface AuthControllerOptions {
  agentDir: string;
  /** The operation changed: every viewer is told what it may know. */
  publish: () => void;
  /** pi's auth file changed. The running session has not seen it yet. */
  changed: (providerId: string, change: "login" | "logout") => void;
  createRuntime?: () => Promise<AuthRuntime>;
  /** Absolute lifetime of one operation, whatever the provider's own expiry. */
  limitMs?: number;
}
/**
 * OAuth logins that only show a code and poll: they work from any device and need no listener on the
 * host. Flows with a localhost callback are not offered from the browser until they are verified there.
 */
const DEVICE_CODE_OAUTH = new Set(["kimi-coding", "github-copilot", "xai", "meta"]);
const LIMIT_MS = 15 * 60_000;
const clip = (text: string, length: number): string => text.length <= length ? text : `${text.slice(0, length)}…`;
const aborted = (): Error => Object.assign(new Error("The login was cancelled."), { name: "AbortError" });

interface Operation {
  id: string; providerId: string; providerName: string; method: "api_key" | "oauth"; owner: string;
  status: AccountOperation["status"]; startedAt: number; expiresAt: number;
  controller: AbortController; timer: ReturnType<typeof setTimeout>;
  step?: AccountStep & { resolve: (value: string) => void; reject: (error: Error) => void; release: () => void };
  notices: AccountNotice[];
  /** What the user typed, kept only while the operation runs so it can be removed from any error text. */
  answers: string[];
  cancelReason?: string;
  error?: { code: string; message: string };
}

/**
 * pi's own login and logout, driven from a browser. The host holds no session for this and loads no
 * extensions or project model configuration: it calls the public ModelRuntime, which stores credentials
 * in pi's auth file under its own lock. One operation at a time. Its steps go only to the page that
 * started it; an operation does not depend on that page staying connected.
 */
export class AuthController {
  private operation?: Operation;
  private disposed = false;
  constructor(private readonly options: AuthControllerOptions) {}

  /**
   * A fresh runtime each time, so the list reflects the file as it is now. `refreshOnCreate: false` is
   * what keeps this read-only: an availability refresh would resolve stored keys, and a stored key may
   * be a command.
   */
  private runtime(): Promise<AuthRuntime> {
    return this.options.createRuntime?.() ?? (ModelRuntime.create({ authPath: join(this.options.agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false }) as unknown as Promise<AuthRuntime>);
  }
  /** Built-in providers with their login methods and the kind of credential stored for each. No secret is read. */
  async providers(): Promise<AccountProvider[]> {
    const runtime = await this.runtime();
    const stored = new Map((await runtime.listCredentials()).map(item => [item.providerId, item.type]));
    return runtime.getProviders().map(provider => {
      const methods: AccountMethod[] = [];
      if (provider.auth?.apiKey) methods.push({ type: "api_key", label: clip(provider.auth.apiKey.name, 120), web: !!provider.auth.apiKey.login, ...(provider.auth.apiKey.login ? {} : { reason: "ambient" as const }) });
      if (provider.auth?.oauth) methods.push({ type: "oauth", label: clip(provider.auth.oauth.name, 120), web: DEVICE_CODE_OAUTH.has(provider.id), ...(DEVICE_CODE_OAUTH.has(provider.id) ? {} : { reason: "callback" as const }) });
      const kind = stored.get(provider.id);
      return { id: provider.id, name: clip(provider.name, 120), methods, ...(kind ? { stored: kind } : {}), models: 0, knownModels: runtime.getModels(provider.id).length };
    });
  }
  get busy(): boolean { return this.operation?.status === "running"; }
  /** What `leaseId` may know: everything for the owner, only that something is running for anyone else. */
  view(leaseId: string | undefined): AccountOperation | null {
    const operation = this.operation;
    if (!operation) return null;
    const base = { id: operation.id, providerId: operation.providerId, providerName: operation.providerName, method: operation.method, status: operation.status, startedAt: operation.startedAt, expiresAt: operation.expiresAt };
    if (operation.owner !== leaseId) return operation.status === "running" ? { ...base, owner: false } : null;
    const step = operation.step && { id: operation.step.id, kind: operation.step.kind, message: operation.step.message,
      ...(operation.step.placeholder ? { placeholder: operation.step.placeholder } : {}), ...(operation.step.options ? { options: operation.step.options } : {}) };
    return { ...base, owner: true, ...(step ? { step } : {}), ...(operation.notices.length ? { notices: structuredClone(operation.notices) } : {}), ...(operation.error ? { error: operation.error } : {}) };
  }
  async begin(leaseId: string, providerId: string, method: "api_key" | "oauth"): Promise<{ operationId: string }> {
    if (this.disposed) throw new ProtocolError("host_stopped", "The service is stopping.");
    if (this.busy) throw new ProtocolError("account_busy", "Another account operation is in progress. Finish or cancel it first.");
    const runtime = await this.runtime();
    const provider = runtime.getProviders().find(item => item.id === providerId);
    if (!provider) throw new ProtocolError("unknown_provider", "This provider is not one of pi's built-in providers. Providers added by extensions sign in from the terminal.");
    const supported = method === "api_key" ? !!provider.auth?.apiKey?.login : !!provider.auth?.oauth && DEVICE_CODE_OAUTH.has(providerId);
    if (!supported) throw new ProtocolError("unsupported_method", "This login method is not available from the browser. Use /login in a terminal.");
    if (this.busy) throw new ProtocolError("account_busy", "Another account operation is in progress. Finish or cancel it first.");
    const limit = this.options.limitMs ?? LIMIT_MS;
    const operation: Operation = { id: randomUUID(), providerId, providerName: clip(provider.name, 120), method, owner: leaseId, status: "running",
      startedAt: Date.now(), expiresAt: Date.now() + limit, controller: new AbortController(), notices: [], answers: [],
      timer: setTimeout(() => this.abort(operation, "timeout"), limit) };
    operation.timer.unref?.();
    this.operation = operation;
    this.options.publish();
    void this.run(operation, runtime);
    return { operationId: operation.id };
  }
  private async run(operation: Operation, runtime: AuthRuntime): Promise<void> {
    const interaction: AuthInteraction = { signal: operation.controller.signal, prompt: prompt => this.ask(operation, prompt), notify: event => this.note(operation, event) };
    let saved = false;
    try {
      const credential = await runtime.login(operation.providerId, operation.method, interaction);
      // Every key answer was escaped to a literal before pi saw it. A stored key that is still a command
      // or an interpolation did not come from such an answer: remove it rather than leave it to be resolved.
      if (operation.method === "api_key" && typeof credential.key === "string" && configValueKind(credential.key) !== "literal") {
        await runtime.logout(operation.providerId).catch(() => undefined);
        throw new ProtocolError("unsafe_key", "This provider's key could not be stored as a literal value. Nothing was saved; use /login in a terminal.");
      }
      saved = true;
    } catch (error) {
      if (error instanceof CredentialSynchronizationError) saved = true; // stored; only the host-side snapshot failed, which this host does not use
      else if (operation.controller.signal.aborted) {
        operation.status = "cancelled";
        operation.error = operation.cancelReason === "timeout" ? { code: "timeout", message: "The login was not completed in time." }
          : operation.cancelReason === "owner_gone" ? { code: "owner_gone", message: "The page that started this login is no longer signed in." } : { code: "cancelled", message: "The login was cancelled." };
      } else {
        operation.status = "failed";
        let message = error instanceof Error ? error.message : String(error);
        for (const answer of operation.answers) if (answer.length >= 4) message = message.split(answer).join("[hidden]");
        operation.error = { code: error instanceof ProtocolError ? error.code : "login_failed", message: clip(message, 400) };
      }
    }
    clearTimeout(operation.timer);
    operation.step?.release(); operation.step = undefined; operation.answers = []; operation.notices = operation.notices.filter(notice => notice.type === "info");
    if (saved) { operation.status = "saved"; this.options.changed(operation.providerId, "login"); }
    this.options.publish();
  }
  private ask(operation: Operation, prompt: AuthPrompt): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (operation.controller.signal.aborted || prompt.signal?.aborted) { reject(aborted()); return; }
      operation.step?.reject(aborted()); // pi asks one thing at a time; a new question replaces an unanswered one
      const withdraw = () => { release(); if (operation.step === step) { operation.step = undefined; this.options.publish(); } reject(aborted()); };
      const release = () => { operation.controller.signal.removeEventListener("abort", withdraw); prompt.signal?.removeEventListener("abort", withdraw); };
      const step: NonNullable<Operation["step"]> = { id: randomUUID(), kind: prompt.type, message: clip(prompt.message, 1000),
        ...("placeholder" in prompt && prompt.placeholder ? { placeholder: clip(prompt.placeholder, 200) } : {}),
        ...(prompt.type === "select" ? { options: prompt.options.slice(0, 32).map(option => ({ id: clip(option.id, 128), label: clip(option.label, 200), ...(option.description ? { description: clip(option.description, 400) } : {}) })) } : {}),
        resolve: value => { release(); resolve(value); }, reject: error => { release(); reject(error); }, release };
      // The whole login was cancelled, or pi withdrew this question (a callback arrived while a manual code was being asked for).
      operation.controller.signal.addEventListener("abort", withdraw, { once: true });
      prompt.signal?.addEventListener("abort", withdraw, { once: true });
      operation.step = step;
      this.options.publish();
    });
  }
  private note(operation: Operation, event: AuthEvent): void {
    if (operation.status !== "running") return;
    const notice: AccountNotice = event.type === "info" ? { type: "info", message: clip(event.message, 1000), ...(event.links?.length ? { links: event.links.slice(0, 4).map(link => ({ url: clip(link.url, 2000), ...(link.label ? { label: clip(link.label, 120) } : {}) })) } : {}) }
      : event.type === "auth_url" ? { type: "auth_url", url: clip(event.url, 4000), ...(event.instructions ? { instructions: clip(event.instructions, 1000) } : {}) }
      : event.type === "device_code" ? { type: "device_code", userCode: clip(event.userCode, 64), verificationUri: clip(event.verificationUri, 2000), ...(event.expiresInSeconds ? { expiresAt: Date.now() + event.expiresInSeconds * 1000 } : {}) }
      : { type: "progress", message: clip(event.message, 400) };
    // The latest of each kind is what the page shows; a flow that polls reports progress many times.
    operation.notices = [...operation.notices.filter(item => item.type !== notice.type), notice].slice(-6);
    this.options.publish();
  }
  /**
   * The answer to the current step. One valid answer per step, from the owner only. A key is turned into
   * a literal before pi stores it: pi resolves a stored key as a config value, where a leading `!` runs
   * a command on the host and `$NAME` reads the environment.
   */
  answer(leaseId: string, operationId: string, stepId: string, value: string): void {
    const operation = this.operation;
    if (!operation || operation.id !== operationId || operation.status !== "running") throw new ProtocolError("operation_closed", "This login is no longer running.");
    if (operation.owner !== leaseId) throw new ProtocolError("not_owner", "Only the page that started this login can answer it.");
    const step = operation.step;
    if (!step || step.id !== stepId) throw new ProtocolError("stale_step", "This step was already answered or replaced.");
    if (step.kind === "select") { if (!step.options?.some(option => option.id === value)) throw new ProtocolError("invalid_answer", "Choose one of the listed options."); }
    else if (!value.trim()) throw new ProtocolError("invalid_answer", "Enter a value, or cancel the login.");
    let answer = value;
    if (operation.method === "api_key") {
      if (step.kind === "secret") answer = literalConfigValue(value);
      // Other fields of a key login are identifiers. They are not escaped, so they must already be literal.
      else if (step.kind !== "select" && configValueKind(value) !== "literal") throw new ProtocolError("invalid_answer", "This field cannot start with ! or contain $.");
    }
    operation.step = undefined;
    if (step.kind !== "select") operation.answers.push(value, answer);
    step.resolve(answer);
    this.options.publish();
  }
  private abort(operation: Operation, reason: string): void {
    if (operation.status !== "running" || operation.controller.signal.aborted) return;
    operation.cancelReason = reason;
    operation.controller.abort();
  }
  /** Any signed-in page may cancel: they are all the same owner. Releases pi's polling and any listener through its abort signal. */
  cancel(operationId: string): void {
    const operation = this.operation;
    if (!operation || operation.id !== operationId || operation.status !== "running") throw new ProtocolError("operation_closed", "This login is no longer running.");
    this.abort(operation, "cancelled");
  }
  /** The owner's lease expired or its access was revoked: nobody is left who may see the steps. */
  leaseEnded(leaseId: string): void { if (this.operation?.owner === leaseId) this.abort(this.operation, "owner_gone"); }
  /** Removes the stored credential only. It does not revoke anything at the provider, nor an environment variable or start argument. */
  async logout(providerId: string): Promise<void> {
    if (this.busy) throw new ProtocolError("account_busy", "Another account operation is in progress. Finish or cancel it first.");
    const runtime = await this.runtime();
    if (!(await runtime.listCredentials()).some(item => item.providerId === providerId)) throw new ProtocolError("not_stored", "pi has no stored credential for this provider. One provided by the environment or a start argument cannot be removed here.");
    try { await runtime.logout(providerId); }
    catch (error) { if (!(error instanceof CredentialSynchronizationError)) throw error; }
    this.options.changed(providerId, "logout");
  }
  dispose(): void { this.disposed = true; if (this.operation) this.abort(this.operation, "cancelled"); }
}
