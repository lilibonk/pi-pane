/** Shared isolation and RPC helpers for the M3.1 gate spikes. Temporary HOME/agentDir, no network, no real credentials. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piPackage = join(project, "node_modules/@earendil-works/pi-coding-agent");
const piManifest = JSON.parse(await readFile(join(piPackage, "package.json"), "utf8"));
export const piVersion = piManifest.version;
export const rpcEntry = join(piPackage, piManifest.exports["./rpc-entry"].import);
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export async function waitFor(check, label, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}

/** A task-owned root: HOME, agent directory, event log and any number of project directories. */
export async function makeRoot({ settings = {}, projects = ["A", "B"] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-pane-m31-")));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "pi-pane-m0", defaultModel: "deterministic",
    quietStartup: true, lastChangelogVersion: piVersion, packages: [], compaction: { enabled: false }, ...settings }), { mode: 0o600 });
  const eventPath = join(root, "events.jsonl");
  await writeFile(eventPath, "", { mode: 0o600 });
  // An allowlist avoids inheriting real provider/API credentials into the fixture.
  const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { HOME: root, PI_OFFLINE: "1", NO_COLOR: "1", PI_CODING_AGENT_DIR: agentDir, PI_M0_EVENTS_PATH: eventPath });
  const dirs = {};
  for (const name of projects) { dirs[name] = join(root, "projects", name); await mkdir(dirs[name], { recursive: true }); }
  return {
    root, agentDir, eventPath, env, dirs,
    async events(name) {
      const all = (await readFile(eventPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return name ? all.filter((item) => item.event === name) : all;
    },
    async clearEvents() { await writeFile(eventPath, ""); },
    /** A project extension that only records that it was loaded: evidence of granted project trust. */
    async addProjectExtension(name) {
      const directory = join(dirs[name], ".pi", "extensions");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "marker.ts"), `import { appendFileSync } from "node:fs";
export default function marker() {
  appendFileSync(process.env.PI_M0_EVENTS_PATH, JSON.stringify({ at: Date.now(), event: "m31_project_extension", project: ${JSON.stringify(name)}, pid: process.pid, processCwd: process.cwd() }) + "\\n");
}
`);
    },
    remove() { return rm(root, { recursive: true, force: true }); },
  };
}

export const baseArgs = ({ discovery = false } = {}) => [...(discovery ? [] : ["--no-extensions"]), "--no-skills", "--no-prompt-templates", "--no-themes",
  "-e", join(project, "tests/fixtures/deterministic-provider.ts"), "-e", join(project, "tests/fixtures/m31-probe.ts")];

/** One `pi --mode rpc` process over its public JSONL protocol. */
export function rpcChild(root, cwd, args = [], env = {}) {
  const proc = spawn(process.execPath, [rpcEntry, ...args], { cwd, env: { ...root.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const child = { proc, pid: proc.pid, records: [], stderr: "", exitCode: undefined, exitSignal: undefined, exitedAt: undefined, nextId: 0 };
  child.exited = new Promise((done) => proc.once("exit", (code, signal) => {
    child.exitCode = code; child.exitSignal = signal; child.exitedAt = Date.now();
    for (const { reject } of pending.values()) reject(new Error(`RPC child exited (${code}/${signal}): ${child.stderr.slice(-400)}`));
    pending.clear(); done(code);
  }));
  proc.stderr.on("data", (data) => { child.stderr = (child.stderr + data).slice(-8192); });
  proc.stdin.on("error", () => {});
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (record?.type === "response" && pending.has(record.id)) {
      const request = pending.get(record.id); pending.delete(record.id);
      if (record.success === false) request.reject(new Error(String(record.error))); else request.resolve(record.data);
      return;
    }
    child.records.push({ at: Date.now(), ...record });
  });
  child.request = (type, payload = {}, timeoutMs = 20_000) => new Promise((resolveRequest, reject) => {
    const id = `g${++child.nextId}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveRequest(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    proc.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
  });
  child.send = (record) => proc.stdin.write(`${JSON.stringify(record)}\n`);
  /** Sends a prompt and waits until the agent has settled. */
  child.prompt = async (message) => {
    const from = child.records.length;
    const result = await child.request("prompt", { message });
    if (result?.disposition !== "handled") await waitFor(() => child.records.slice(from).some((record) => record.type === "agent_settled"), `agent_settled for ${message}`);
    return result;
  };
  /** The only graceful stop the public RPC protocol offers: end of input. */
  child.end = () => { child.endedAt = Date.now(); proc.stdin.end(); };
  child.stop = async (graceMs = 8000) => {
    if (child.exitCode !== undefined || child.exitSignal !== undefined) return;
    child.end();
    const timer = setTimeout(() => proc.kill("SIGKILL"), graceMs);
    await child.exited; clearTimeout(timer);
  };
  return child;
}

export async function sessionHeader(path) {
  const first = (await readFile(path, "utf8")).split("\n", 1)[0];
  return JSON.parse(first);
}

/** Records observations; an unexpected result is reported, never hidden. */
export function reporter(scope) {
  const report = { scope, piVersion, startedAt: new Date().toISOString(), realModelCalls: 0, observations: [] };
  return {
    report,
    async observe(id, question, fn) {
      const started = Date.now();
      try {
        const { expected = true, ...details } = await fn();
        report.observations.push({ id, question, status: expected ? "as_expected" : "unexpected", durationMs: Date.now() - started, details });
        console.log(`${expected ? "OK  " : "DIFF"} ${id} ${question}`);
      } catch (error) {
        report.observations.push({ id, question, status: "error", durationMs: Date.now() - started, error: String(error?.stack ?? error).slice(0, 2000) });
        console.log(`ERR  ${id} ${question}: ${error?.message ?? error}`);
      }
    },
  };
}
