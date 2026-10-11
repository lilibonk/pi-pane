import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderConfig } from "../src/extension/provider-config.js";
import { validateProvider } from "../src/protocol/index.js";

const none = new Set<string>();
async function fixture(run: (context: { dir: string; path: string; config: ProviderConfig; disk: () => Promise<any> }) => Promise<void>, initial?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pi-pane-providers-")), path = join(dir, "models.json");
  if (initial !== undefined) await writeFile(path, typeof initial === "string" ? initial : JSON.stringify(initial, null, 2), { mode: 0o600 });
  try { await run({ dir, path, config: new ProviderConfig(dir), disk: async () => JSON.parse(await readFile(path, "utf8")) }); }
  finally { await chmod(path, 0o600).catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
}
const input = (extra: Record<string, unknown> = {}) => ({ id: "local", api: "openai-completions", baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen2.5-coder:7b" }], ...extra });

test("a new provider is written as its own entry, without a key, into a file that did not exist", () => fixture(async ({ path, config, disk }) => {
  const empty = await config.read(); assert.deepEqual([empty.providers, empty.revision, empty.error], [[], "absent", undefined]);
  const saved = await config.save(input({ models: [{ id: "a", name: "Model A", contextWindow: 32000 }, { id: "b" }] }), "absent", true, none);
  assert.equal(saved.id, "local"); assert.equal(saved.insecure, false);
  assert.deepEqual(await disk(), { providers: { local: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "a", name: "Model A", contextWindow: 32000 }, { id: "b" }] } } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const view = await config.read(); assert.equal(view.revision, saved.revision);
  assert.deepEqual(view.providers, [{ id: "local", api: "openai-completions", baseUrl: "http://localhost:11434/v1", models: [{ id: "a", name: "Model A", contextWindow: 32000 }, { id: "b" }], extra: [], modelExtras: 0, insecure: false }]);
  await assert.rejects(config.save(input(), saved.revision, true, none), { code: "provider_exists", field: "id" });
  assert.deepEqual((await readdir(join(path, ".."))).sort(), ["models.json"], "no lock or temporary file is left behind");
}));
test("editing keeps every field the form does not show, in this entry, in its models and in the rest of the file", () => fixture(async ({ config, disk }) => {
  const before = await config.read();
  assert.deepEqual(before.providers.find(provider => provider.id === "proxy"), { id: "proxy", api: "anthropic-messages", baseUrl: "https://proxy.example/v1",
    models: [{ id: "big", name: "Big", contextWindow: 200000 }, { id: "small" }], extra: ["headers", "modelOverrides", "futureField"], modelExtras: 1, insecure: false });
  assert.deepEqual([...before.fileKeys], [["proxy", "file_command"], ["env", "file_env"], ["plain", "file_literal"]]);
  await config.save({ id: "proxy", api: "anthropic-messages", baseUrl: "https://proxy.example/v2", models: [{ id: "small", name: "Small" }, { id: "big", contextWindow: 100000 }, { id: "new" }] }, before.revision, false, none);
  const after = await disk();
  assert.deepEqual(after.providers.proxy, { baseUrl: "https://proxy.example/v2", api: "anthropic-messages", apiKey: "!op read secret", headers: { "x-team": "$TEAM" }, modelOverrides: { other: { name: "kept" } }, futureField: [1, 2],
    models: [{ id: "small", name: "Small" }, { id: "big", input: ["text", "image"], inputLimits: { images: { maxPerMessage: 4 } }, contextWindow: 100000 }, { id: "new" }] });
  // The cleared display name is gone; nothing else of the model was touched.
  assert.deepEqual([after.providers.env, after.providers.plain, after.topLevel, after.providers.odd], [{ baseUrl: "https://env.example", api: "openai-completions", apiKey: "$MY_KEY", models: [{ id: "e" }] },
    { baseUrl: "https://plain.example", api: "openai-completions", apiKey: "sk-in-file", models: [{ id: "p" }] }, { keep: true }, "not an object"]);
  assert.deepEqual(Object.keys(after.providers), ["proxy", "env", "plain", "odd"], "order is kept");
  // An entry with a protocol the form does not offer can be edited as long as the protocol is not changed.
  await config.save({ id: "env", api: "openai-completions", baseUrl: "https://env.example/v1", models: [{ id: "e" }] }, (await config.read()).revision, false, none);
  assert.equal((await disk()).providers.env.apiKey, "$MY_KEY", "a key already in the file is never rewritten");
}, { topLevel: { keep: true }, providers: {
  proxy: { baseUrl: "https://proxy.example/v1", api: "anthropic-messages", apiKey: "!op read secret", headers: { "x-team": "$TEAM" }, modelOverrides: { other: { name: "kept" } }, futureField: [1, 2],
    models: [{ id: "big", name: "Big", contextWindow: 200000, input: ["text", "image"], inputLimits: { images: { maxPerMessage: 4 } } }, { id: "small" }] },
  env: { baseUrl: "https://env.example", api: "openai-completions", apiKey: "$MY_KEY", models: [{ id: "e" }] },
  plain: { baseUrl: "https://plain.example", api: "openai-completions", apiKey: "sk-in-file", models: [{ id: "p" }] }, odd: "not an object" } }));
test("a key in the file is reported by kind only", () => fixture(async ({ config }) => {
  const view = await config.read();
  assert.equal(JSON.stringify(view.providers).includes("sk-in-file"), false); assert.equal(JSON.stringify(view.providers).includes("op read"), false);
  assert.equal(JSON.stringify([...view.fileKeys]).includes("sk-"), false);
}, { providers: { a: { baseUrl: "https://a.example", api: "openai-completions", apiKey: "sk-in-file", models: [{ id: "m" }] }, b: { baseUrl: "https://b.example", api: "openai-completions", apiKey: "!op read secret", models: [{ id: "m" }] } } }));
test("a change made from an older view of the file is refused and the file is left as it is", () => fixture(async ({ path, config, disk }) => {
  const first = await config.read();
  const raw = await disk(); raw.providers.other = { baseUrl: "https://other.example", api: "openai-completions", models: [{ id: "o" }] }; await writeFile(path, JSON.stringify(raw));
  const external = await readFile(path, "utf8");
  await assert.rejects(config.save(input({ id: "mine", baseUrl: "https://mine.example" }), first.revision, false, none), { code: "stale_providers" });
  await assert.rejects(config.remove("mine", first.revision, none), { code: "stale_providers" });
  assert.equal(await readFile(path, "utf8"), external);
  const fresh = await config.read(); assert.notEqual(fresh.revision, first.revision); assert.equal(fresh.providers.length, 2);
  // Two pages from the same view: the first wins, the second must look again.
  const [one, two] = await Promise.allSettled([config.save(input({ id: "one" }), fresh.revision, true, none), config.save(input({ id: "two" }), fresh.revision, true, none)]);
  assert.deepEqual([one.status, two.status].sort(), ["fulfilled", "rejected"]); assert.equal(Object.keys((await disk()).providers).length, 3);
}, { providers: { mine: { baseUrl: "https://mine.example", api: "openai-completions", models: [{ id: "m" }] } } }));
test("a broken file is shown as broken and never overwritten; a read-only one is not reported as saved", { skip: process.getuid?.() === 0 }, () => fixture(async ({ dir, path, config }) => {
  const view = await config.read(); assert.deepEqual(view.providers, []); assert.match(view.error!, /not valid JSON/);
  await assert.rejects(config.save(input(), view.revision, true, none), { code: "providers_unreadable" });
  await assert.rejects(config.remove("local", view.revision, none), { code: "providers_unreadable" });
  assert.equal(await readFile(path, "utf8"), "{ \"providers\": ");
  for (const text of ["[1]", "{\"providers\": []}"]) { await writeFile(path, text); const bad = await config.read(); assert.ok(bad.error); await assert.rejects(config.save(input(), bad.revision, true, none), { code: "providers_unreadable" }); assert.equal(await readFile(path, "utf8"), text); }
  await writeFile(path, "{}"); const empty = await config.read();
  await chmod(dir, 0o500);
  try { await assert.rejects(config.save(input(), empty.revision, true, none)); assert.equal(await readFile(path, "utf8"), "{}"); } finally { await chmod(dir, 0o700); }
  assert.equal((await config.save(input(), empty.revision, true, none)).id, "local", "the same change can be retried");
}, "{ \"providers\": "));
test("each invalid field is named", () => {
  const field = (extra: Record<string, unknown>, expected: string) => assert.throws(() => validateProvider(input(extra) as never), (error: any) => { assert.equal(error.code, "invalid_provider"); assert.equal(error.field, expected, error.message); return true; });
  for (const id of ["", "has space", "a/b", "-flag", "../up", "x".repeat(65), "名字"]) field({ id }, "id");
  field({ api: "made-up-api" }, "api");
  for (const baseUrl of ["", "example.com/v1", "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com/v1", "http://"]) field({ baseUrl }, "baseUrl");
  field({ models: [] }, "models"); field({ models: Array.from({ length: 65 }, (_, index) => ({ id: `m${index}` })) }, "models");
  field({ models: [{ id: "ok" }, { id: " " }] }, "models.1.id"); field({ models: [{ id: "same" }, { id: "same" }] }, "models.1.id"); field({ models: [{ id: "a\nb" }] }, "models.0.id");
  for (const contextWindow of [0, -1, 1.5, Number.NaN, 1e12]) field({ models: [{ id: "m", contextWindow }] }, "models.0.contextWindow");
  field({ models: [{ id: "m", name: "x".repeat(201) }] }, "models.0.name");
  // Plain http is accepted and flagged unless it is this machine.
  for (const [baseUrl, insecure] of [["http://localhost:11434/v1", false], ["http://127.0.0.1:8080", false], ["http://[::1]:8080/v1", false], ["http://app.localhost/v1", false], ["https://api.example.com/v1", false],
    ["http://192.168.1.20:8000/v1", true], ["http://api.example.com/v1", true], ["http://127.evil.example/v1", true]] as const) assert.equal(validateProvider(input({ baseUrl }) as never).insecure, insecure, baseUrl);
  assert.deepEqual(validateProvider({ id: " mine ", api: "openai-responses", baseUrl: " https://x.example/v1 ", models: [{ id: " m ", name: "  ", contextWindow: 8000 }] }),
    { id: "mine", api: "openai-responses", baseUrl: "https://x.example/v1", models: [{ id: "m", contextWindow: 8000 }], insecure: false });
  // An unlisted protocol is accepted only where it is what the entry already has.
  assert.equal(validateProvider(input({ api: "bedrock-converse-stream" }) as never, { api: "bedrock-converse-stream" }).api, "bedrock-converse-stream");
});
test("names pi already gives a meaning to cannot be created, edited or removed here", () => fixture(async ({ config, disk }) => {
  const reserved = new Set(["openai", "from-extension"]), view = await config.read();
  await assert.rejects(config.save(input({ id: "openai" }), view.revision, true, reserved), { code: "provider_name_taken", field: "id" });
  await assert.rejects(config.save(input({ id: "from-extension" }), view.revision, true, reserved), { code: "provider_name_taken", field: "id" });
  await assert.rejects(config.save(input({ id: "openai" }), view.revision, false, reserved), { code: "provider_overlay" });
  await assert.rejects(config.remove("openai", view.revision, reserved), { code: "provider_overlay" });
  await assert.rejects(config.remove("absent", view.revision, none), { code: "provider_missing" });
  await assert.rejects(config.save(input({ id: "absent" }), view.revision, false, none), { code: "provider_missing" });
  assert.deepEqual(Object.keys((await disk()).providers), ["openai", "mine"]);
  const removed = await config.remove("mine", view.revision, reserved);
  assert.deepEqual(await disk(), { providers: { openai: { baseUrl: "https://gateway.example/v1", api: "openai-completions", models: [{ id: "extra" }] } } }); assert.equal((await config.read()).revision, removed.revision);
}, { providers: { openai: { baseUrl: "https://gateway.example/v1", api: "openai-completions", models: [{ id: "extra" }] }, mine: { baseUrl: "https://mine.example", api: "openai-completions", models: [{ id: "m" }] } } }));
