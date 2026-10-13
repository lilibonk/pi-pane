#!/usr/bin/env node
/**
 * Frozen-candidate regression matrix. Builds are supplied by the caller and never rebuilt here.
 * Each suite gets a new HOME/agent/TMPDIR, its own reports and log, and content hashes before/after.
 * Real-provider trials and the exact-package installation gate are deliberately separate.
 *
 * Inspect: node scripts/m31-regression.mjs --list
 * Run:     node scripts/m31-regression.mjs --run --output build-artifacts/releases/<candidate>/regression
 * Subset:  add --suite m31:integration (repeatable); subsets never claim a full-matrix pass.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suite = (name, script, envKey, reports = [[name, "report.json"]], extras = {}) => ({ name, script, envKey, reports, timeoutMs: 10 * 60_000, ...extras });
const definitions = [
  suite("m0:smoke", "scripts/m0-smoke.mjs", "PI_M0_REPORT_DIR", [["m0:smoke", "smoke-report.json"]]),
  suite("m0:browser", "scripts/m0-browser.mjs", "PI_M0_REPORT_DIR", [["m0:browser", "browser-report.json"]]),
  suite("m0:lifecycle", "scripts/m0-lifecycle.mjs", "PI_M0_LIFECYCLE_REPORT_DIR", [["m0:lifecycle", "lifecycle-report.json"]]),
  suite("m0:boundaries", "scripts/m0-boundaries.mjs", "PI_M0_REPORT_DIR", [["m0:boundaries", "boundary-report.json"]]),
  suite("m0:projection", "scripts/m0-projection-extra.mjs", "PI_M0_PROJECTION_REPORT_DIR"),
  suite("m1:render", "scripts/m1-render.mjs", "PI_M1_REPORT_DIR", [["m1:render", "render-report.json"]]),
  suite("m1:a6", "scripts/m1-a6.mjs", "PI_M1_REPORT_DIR"),
  suite("m2:images", "scripts/m2-images.mjs", "PI_M2_REPORT_DIR"),
  suite("m2:external", "scripts/m2-external.mjs", "PI_M2_REPORT_DIR", undefined, { env: { PI_M31_EXTERNAL: "1" } }),
  suite("m3:handoff-long", "scripts/m3-handoff.mjs", "PI_M3_HANDOFF_REPORT_DIR", undefined, { env: { PI_M3_LONG: "1" } }),
  suite("m3:workbench", "scripts/m3-workbench.mjs", "PI_M3_REPORT_DIR"),
  ...["runtime", "projects", "auth", "settings", "providers", "ui"].map(name => suite(`m31:${name}`, `scripts/m31-${name}.mjs`, "PI_M31_REPORT_DIR")),
  suite("m31:design", "scripts/m31-design.mjs", "PI_M31_DESIGN_REPORT_DIR"),
  suite("m31:redesign", "scripts/m31-redesign.mjs", "PI_M31_REDESIGN_REPORT_DIR"),
  suite("m31:theme-tui", "scripts/m31-theme-tui.mjs", "PI_M31_THEME_REPORT_DIR"),
  suite("m31:integration", "scripts/m31-integration.mjs", "PI_M31_REPORT_DIR"),
  suite("m31:concurrency", "scripts/m31-concurrency.mjs", "PI_M31_REPORT_DIR"),
  suite("m31:compat", "scripts/m31-compat.mjs", "PI_M31_REPORT_DIR"),
  suite("m31:resilience", "scripts/m31-resilience.mjs", "PI_M31_REPORT_DIR"),
  // Last and serial: earlier browsers/fixtures must be fully cleaned before collecting timings.
  suite("m0:performance+theme", "scripts/m0-performance.mjs", "PI_M0_REPORT_DIR", [["m0:performance", "performance/report.json"], ["m0:theme", "theme/report.json"]], { timeoutMs: 20 * 60_000 }),
];
const excluded = [
  { name: "m2:install", reason: "Exact frozen tarball installation is a separate gate with its own artifact hash and report." },
  { name: "m2:real-model", reason: "Real-provider calls require separate authorization; this runner never reads daily credentials." },
  { name: "m31:auth-real", reason: "Real-provider authentication trials are excluded from this credential-isolated matrix." },
  { name: "m31:gates", reason: "G1–G5 API feasibility observations are retained separately and are not converted into product acceptance pass counts." },
  { name: "m3:handoff-spike / m2:preview", reason: "Superseded exploratory/manual-preview harnesses are not counted as regression passes." },
];
const options = { run: false, list: false, output: undefined, tarball: undefined, suites: [] };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--run") options.run = true;
  else if (arg === "--list") options.list = true;
  else if (["--output", "--tarball", "--suite"].includes(arg)) {
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (arg === "--suite") options.suites.push(value); else options[arg.slice(2)] = resolve(value);
  } else throw new Error(`Unknown option ${arg}. Use --list or --run --output <new directory>.`);
}
const selected = options.suites.length ? definitions.filter(item => options.suites.includes(item.name)) : definitions;
for (const name of options.suites) if (!definitions.some(item => item.name === name)) throw new Error(`Unknown suite ${name}.`);
if (new Set(options.suites).size !== options.suites.length) throw new Error("Each --suite must be unique.");
const command = item => [process.execPath, "--import", "tsx", item.script];
if (options.list || !options.run) {
  console.log(JSON.stringify({ mode: "plan-only", selected: await Promise.all(selected.map(async item => ({ name: item.name, command: command(item), reportEnvironment: item.envKey,
    reports: item.reports, extraEnvironment: item.env ?? {}, timeoutMinutes: item.timeoutMs / 60_000, scriptExists: await access(join(project, item.script)).then(() => true, () => false) }))),
    excluded, execution: "Serial. A fresh output directory and --run are required; wait until source, harnesses and build have been frozen.",
    expectedDuration: "Approximately 15–25 minutes for the complete local matrix; the long handoff alone waits more than two minutes. This is an estimate, not a test result." }, null, 2));
  process.exit(0);
}
if (!options.output) throw new Error("--run requires --output <new directory>; existing evidence is never reused or overwritten.");
if (process.platform === "win32") throw new Error("This matrix uses POSIX PTYs and process cleanup inspection; Windows is unsupported.");
const output = options.output;
const watched = {
  source: ["src", "themes", "theme-decorations", "public", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.extension.json", "vite.config.ts", "index.html"],
  harness: ["scripts", "tests"],
  build: ["dist", "web-dist"],
};
const inside = (path, directory) => path === directory || path.startsWith(directory + sep);
for (const path of Object.values(watched).flat()) if (inside(output, join(project, path))) throw new Error("Report output cannot live under a source/build/harness path being frozen.");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error(`Output directory is not empty: ${output}. Choose a new directory; prior evidence is retained.`);
for (const item of selected) await access(join(project, item.script)).catch(() => { throw new Error(`${item.script} is not ready. Complete all selected harnesses before freezing and running.`); });
for (const path of ["dist/extension/index.js", "web-dist/index.html"]) await access(join(project, path)).catch(() => { throw new Error(`Missing ${path}. Build the candidate before running; the runner does not build or install.`); });

const sha256 = value => createHash("sha256").update(value).digest("hex");
const redact = value => String(value).replace(/#(?:t|token)=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const pause = ms => new Promise(done => setTimeout(done, ms));
async function capture() {
  const files = {}, groups = {};
  async function collect(path, group) {
    const absolute = join(project, path), stat = await lstat(absolute);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) await collect(join(path, entry), group);
    } else {
      const file = path.split(sep).join("/");
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Not a regular source/build file: ${file}`);
      files[file] = { group, kind: stat.isSymbolicLink() ? "symlink" : "file", sha256: sha256(stat.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute)) };
    }
  }
  for (const [group, roots] of Object.entries(watched)) for (const path of roots) await collect(path, group);
  const sorted = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  for (const group of Object.keys(watched)) groups[`${group}Sha256`] = sha256(JSON.stringify(sorted.filter(([, item]) => item.group === group)));
  const tarballSha256 = options.tarball ? sha256(await readFile(options.tarball)) : undefined;
  return { ...groups, totalSha256: sha256(JSON.stringify({ files: sorted, tarballSha256 })), ...(tarballSha256 ? { tarballSha256 } : {}), files: Object.fromEntries(sorted) };
}
const digests = ({ files: _files, ...value }) => value;
const difference = (before, after) => [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(path => JSON.stringify(before.files[path]) !== JSON.stringify(after.files[path]));
const initial = await capture();
await writeFile(join(output, "source-build-before.json"), `${JSON.stringify(initial, null, 2)}\n`, { flag: "wx" });
const metadata = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const cleanProcessEnv = Object.fromEntries(["PATH", "LANG", "LC_ALL", "SYSTEMROOT"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pp-r-")));
const summary = { startedAt: new Date().toISOString(), version: metadata.version, sourceCommit: execFileSync("git", ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"], { cwd: project, encoding: "utf8", env: { ...cleanProcessEnv, HOME: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim(),
  platform: process.platform, arch: process.arch, node: process.version, requestedSuites: selected.map(item => item.name), matrixSuites: definitions.map(item => item.name),
  fullMatrix: selected.length === definitions.length, initial: digests(initial), extensionEntry: "dist/extension/index.js",
  ...(options.tarball ? { candidateArtifact: { path: relative(project, options.tarball), sha256: initial.tarballSha256, scope: "Hash recorded for the candidate; exact installed-artifact execution is reported separately." } } : {}),
  credentialPolicy: "No inherited provider keys, sessions, proxies, NODE_OPTIONS or daily HOME. New suite HOME/agent/TMPDIR/XDG directories, empty auth and npm config, PI_OFFLINE=1. Only local deterministic or loopback stand-in providers are selected.",
  realModelCalls: 0, realProviderTrialsSelected: false, excluded, executions: [], suites: [], status: "running",
  performanceScope: "A6 is a browser snapshot P95 test. TUI versus RPC comparisons do not isolate pane overhead. CPU/RSS/event-loop metrics cover the RPC writer, not the separate Hub. Exploratory guards are retained as observations, not invented mandatory passes.",
};
async function save() {
  summary.updatedAt = new Date().toISOString();
  summary.totals = { suitesCompleted: summary.suites.length, executionsCompleted: summary.executions.filter(item => item.finishedAt).length,
    checksPassed: summary.suites.reduce((sum, item) => sum + item.passed, 0), checksObserved: summary.suites.reduce((sum, item) => sum + item.total, 0) };
  await writeFile(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}
await save();

/** Read process metadata only. Never inspect environments or persist unrelated command lines. */
function processTable() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8", env: cleanProcessEnv, maxBuffer: 8 * 1024 * 1024 }).split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3].replace(/\s+/g, " "), command: match[4] }] : [];
  });
}
const identity = item => `${item.pid}\0${item.started}`;
function ownedProcesses(sandbox, mainPid, known) {
  const table = processTable(), selectedPids = new Set(mainPid ? [mainPid] : []);
  for (const item of table) if (item.command.includes(sandbox) || known.has(identity(item))) selectedPids.add(item.pid);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of table) if (selectedPids.has(item.ppid) && !selectedPids.has(item.pid)) { selectedPids.add(item.pid); changed = true; }
  }
  const selected = table.filter(item => selectedPids.has(item.pid) && item.pid !== process.pid);
  for (const item of selected) known.add(identity(item));
  return selected;
}
const processDetails = item => ({ pid: item.pid, parentPid: item.ppid, started: item.started, executable: basename(item.command.split(/\s/)[0] || "unknown") });
async function inventory(directory) {
  const entries = []; let bytes = 0;
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name), stat = await lstat(absolute);
      if (entry.isDirectory()) await visit(absolute);
      else { bytes += stat.size; if (entries.length < 500) entries.push({ path: relative(directory, absolute), bytes: stat.size, type: stat.isSymbolicLink() ? "symlink" : "file" }); }
    }
  }
  await visit(directory).catch(error => { if (error.code !== "ENOENT") throw error; });
  return { entries, sampledEntries: entries.length, bytes, namesOnly: true };
}
let interrupted, active;
function stop(signal) {
  interrupted = signal;
  if (active?.proc.pid) {
    active.execution.interruptedBy = signal;
    try { process.kill(-active.proc.pid, "SIGTERM"); } catch { /* already ended */ }
  }
}
process.on("SIGINT", stop); process.on("SIGTERM", stop);

async function runSuite(item, index) {
  const directory = join(output, item.name.replaceAll(":", "-").replaceAll("+", "-")); await mkdir(directory);
  const sandbox = join(scratch, `s${index}`); await mkdir(sandbox);
  const home = join(sandbox, "h"), agent = join(sandbox, "a"), temporary = join(sandbox, "t"), config = join(sandbox, "c"), cache = join(sandbox, "k");
  for (const path of [home, agent, temporary, config, cache]) await mkdir(path);
  await writeFile(join(agent, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(sandbox, "empty.npmrc"), "", { mode: 0o600 });
  const execution = { name: item.name, command: command(item), startedAt: new Date().toISOString(), reportDirectory: relative(output, directory), log: relative(output, join(directory, "suite.log")), status: "running" };
  summary.executions.push(execution); await save();
  const before = await capture(); execution.before = digests(before);
  if (before.totalSha256 !== initial.totalSha256) { execution.changedFiles = difference(initial, before); throw new Error(`Source/build/harness changed before ${item.name}; no suite was started.`); }
  const env = { ...cleanProcessEnv, HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_STATE_HOME: join(sandbox, "state"),
    PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(agent, "sessions"), PI_OFFLINE: "1", PI_M0_EXTENSION: join(project, "dist/extension/index.js"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", npm_config_userconfig: join(sandbox, "empty.npmrc"), npm_config_globalconfig: join(sandbox, "empty.npmrc"), npm_config_cache: join(cache, "npm"),
    ...(initial.tarballSha256 ? { PI_M31_TARBALL_SHA256: initial.tarballSha256 } : {}), PI_M31_REGRESSION_LOG: join(directory, "suite.log"), PI_M31_REPORT_DIR: directory, [item.envKey]: directory, ...item.env };
  execution.environmentKeys = Object.keys(env).sort(); // Names only: never inherited credential values.
  const log = createWriteStream(join(directory, "suite.log"), { flags: "wx" });
  const known = new Set(), trackers = [];
  let proc, monitor, timeout, heartbeat, killTimeout, processInspectionError;
  const started = Date.now(); console.log(`START ${item.name}`);
  try {
    proc = spawn(process.execPath, command(item).slice(1), { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    active = { proc, execution }; execution.pid = proc.pid;
    for (const stream of [proc.stdout, proc.stderr]) {
      const lines = createInterface({ input: stream }); trackers.push(lines);
      lines.on("line", line => { log.write(`${redact(line)}\n`); });
    }
    const observe = () => { try { ownedProcesses(sandbox, proc.pid, known); } catch (error) { processInspectionError = String(error); } };
    observe(); monitor = setInterval(observe, 500);
    heartbeat = setInterval(() => console.log(`RUNNING ${item.name} ${Math.round((Date.now() - started) / 1000)}s`), 30_000);
    timeout = setTimeout(() => {
      execution.timedOut = true;
      try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already ended */ }
      killTimeout = setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already ended */ } }, 5_000);
    }, item.timeoutMs);
    await new Promise((done, reject) => { proc.once("error", reject); proc.once("exit", (code, signal) => { execution.exitCode = code; execution.signal = signal; done(); }); });
  } catch (error) { execution.launchError = redact(error.stack ?? error); }
  finally {
    clearInterval(monitor); clearInterval(heartbeat); clearTimeout(timeout); clearTimeout(killTimeout); active = undefined;
    // Allow ordinary Chrome/PTY teardown to complete before declaring a process leak.
    let remaining = [];
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        remaining = ownedProcesses(sandbox, undefined, known);
        if (!remaining.length) break;
        await pause(100);
      }
      execution.cleanup = { trackedProcessCount: known.size, processesAfterSuite: remaining.map(processDetails), forcedTermination: [] };
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        if (!remaining.length) break;
        for (const item of remaining) {
          // Recheck both PID and birth time so an unrelated recycled PID is never terminated.
          const current = processTable().find(candidate => identity(candidate) === identity(item));
          if (current && known.has(identity(current))) {
            try { process.kill(current.pid, signal); execution.cleanup.forcedTermination.push({ ...processDetails(current), signal }); } catch { /* exited */ }
          }
        }
        await pause(250); remaining = ownedProcesses(sandbox, undefined, known);
      }
      execution.cleanup.remainingProcesses = remaining.map(processDetails);
    } catch (error) { processInspectionError = String(error); execution.cleanup ??= {}; }
    if (processInspectionError) execution.cleanup.processInspectionError = processInspectionError;
    for (const reader of trackers) reader.close();
    await new Promise(done => log.end(done));
    execution.cleanup.sandboxBeforeRemoval = await inventory(sandbox);
    await writeFile(join(directory, "cleanup-before.json"), `${JSON.stringify(execution.cleanup, null, 2)}\n`);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(error => { execution.cleanup.removalError = redact(error.stack ?? error); });
    execution.cleanup.sandboxRemoved = await access(sandbox).then(() => false, error => error.code === "ENOENT");
    execution.finishedAt = new Date().toISOString(); execution.durationMs = Date.now() - started;
    const after = await capture(); execution.after = digests(after); execution.contentUnchanged = after.totalSha256 === initial.totalSha256;
    if (!execution.contentUnchanged) execution.changedFiles = difference(initial, after);
    await writeFile(join(directory, "execution.json"), `${JSON.stringify(execution, null, 2)}\n`);
    await save();
  }
  for (const [name, reportPath] of item.reports) {
    try {
      const file = join(directory, reportPath), report = JSON.parse(await readFile(file, "utf8")), checks = report.checks;
      if (!Array.isArray(checks)) throw new Error("Report has no checks array; observations are not acceptance passes.");
      const result = { name, report: relative(output, file), status: report.status ?? "missing", passed: checks.filter(check => check.status === "passed").length,
        total: checks.length, failed: checks.filter(check => check.status === "failed").length, other: checks.filter(check => !["passed", "failed"].includes(check.status)).length,
        sha256: sha256(await readFile(file)), startedAt: report.startedAt ?? execution.startedAt, finishedAt: report.finishedAt ?? execution.finishedAt };
      if (report.realModelCalls > 0) throw new Error("Suite reports a real model call in a matrix that forbids real-provider trials.");
      summary.suites.push(result);
      if (result.status !== "passed" || !result.total || result.passed !== result.total) execution.reportFailure = true;
      console.log(`${result.status.toUpperCase()} ${name} ${result.passed}/${result.total}`);
    } catch (error) { execution.reportFailure = true; execution.reportErrors ??= []; execution.reportErrors.push({ report: reportPath, error: redact(error.stack ?? error) }); }
  }
  const cleanupFailed = execution.cleanup.processInspectionError || execution.cleanup.processesAfterSuite?.length || execution.cleanup.remainingProcesses?.length || !execution.cleanup.sandboxRemoved;
  execution.status = execution.exitCode === 0 && !execution.reportFailure && !execution.timedOut && !execution.interruptedBy && execution.contentUnchanged && !cleanupFailed ? "passed" : "failed";
  await writeFile(join(directory, "execution.json"), `${JSON.stringify(execution, null, 2)}\n`); await save();
  if (execution.status !== "passed") throw new Error(`${item.name} failed. Reports, logs, source hashes and cleanup diagnostics were retained in ${directory}.`);
}
try {
  for (const [index, item] of selected.entries()) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}; no additional suite was started.`);
    await runSuite(item, index);
  }
  summary.status = summary.fullMatrix ? "passed" : "passed-subset";
} catch (error) {
  summary.status = interrupted ? "interrupted" : "failed"; summary.error = redact(error.stack ?? error); process.exitCode = 1;
  console.error(summary.error);
} finally {
  summary.finishedAt = new Date().toISOString();
  try {
    const final = await capture(); summary.final = digests(final); summary.contentUnchanged = final.totalSha256 === initial.totalSha256;
    if (!summary.contentUnchanged) { summary.status = "failed"; process.exitCode = 1; summary.changedFiles = difference(initial, final); }
    await writeFile(join(output, "source-build-after.json"), `${JSON.stringify(final, null, 2)}\n`);
  } catch (error) { summary.status = "failed"; process.exitCode = 1; summary.finalHashError = redact(error.stack ?? error); }
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(error => { summary.runnerCleanupError = redact(error.stack ?? error); summary.status = "failed"; process.exitCode = 1; });
  summary.runnerTemporaryRootRemoved = await access(scratch).then(() => false, error => error.code === "ENOENT");
  process.off("SIGINT", stop); process.off("SIGTERM", stop);
  await save();
  console.log(`${summary.status.toUpperCase()} — ${summary.totals.checksPassed}/${summary.totals.checksObserved} observed checks; ${summary.executions.length}/${selected.length} executions; ${join(output, "summary.json")}`);
}
