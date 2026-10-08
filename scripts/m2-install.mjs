#!/usr/bin/env node
// A11 (install): the npm tarball contains the prebuilt extension and web assets; `pi install npm:pi-pane@<version>`
// into a clean agent directory and npm cache installs it without a build; the installed package serves /web.
// A local registry serves this package's tarball and proxies every other package to the public npm registry,
// standing in for publication. Gallery listing requires a real publish and is not covered here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { startFixture, waitFor } from "./m0-smoke.mjs";

const run = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = resolve(process.env.PI_M2_REPORT_DIR ?? join(project, "build-artifacts/m2/install"));
await mkdir(reportDir, { recursive: true });
const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const UPSTREAM = "https://registry.npmjs.org";
const report = { scope: "A11 install: npm tarball contents and pi install from a registry into a clean agent directory", checks: [], status: "running",
  notCovered: ["Publication to npmjs.com and listing in the pi.dev gallery (requires the maintainer to publish)"] };
const check = async (name, action) => {
  const started = Date.now();
  try {
    const details = await action();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: String(error?.stack ?? error).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]") });
    console.log(`FAIL ${name}: ${error}`);
    throw error;
  }
};

const work = await mkdtemp(join(tmpdir(), "pi-pane-m2-install-"));
let registry, fixture, browser;
try {
  let tarball, tarballBytes, files;
  await check("the npm tarball carries the prebuilt extension and web assets, and no sources or tests", async () => {
    // prepack rebuilds dist/ and web-dist/ so the tarball never ships stale output.
    const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", work], { cwd: project, maxBuffer: 16 * 1024 * 1024 });
    const info = JSON.parse(stdout.slice(stdout.indexOf("[")))[0];
    tarball = join(work, info.filename);
    tarballBytes = await readFile(tarball);
    files = info.files.map(file => file.path);
    for (const required of ["package.json", "README.md", "dist/extension/index.js", "dist/protocol/index.js", "web-dist/index.html"]) assert.ok(files.includes(required), required);
    assert.ok(files.some(file => /^web-dist\/assets\/index-.*\.js$/.test(file)), "web bundle");
    assert.ok(files.some(file => /^web-dist\/assets\/index-.*\.css$/.test(file)), "web styles");
    for (const file of files) assert.ok(!/^(src|tests|scripts|build-artifacts|node_modules)\//.test(file), `unexpected ${file}`);
    const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    assert.deepEqual(manifest.pi.extensions, ["./dist/extension/index.js"]);
    assert.ok(manifest.keywords.includes("pi-package"));
    return { filename: info.filename, packedBytes: info.size, unpackedBytes: info.unpackedSize, files: files.length };
  });

  // Registry: this package from the tarball, everything else proxied.
  const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  const shasum = createHash("sha1").update(tarballBytes).digest("hex");
  const requests = [];
  registry = createServer(async (request, response) => {
    requests.push(request.url);
    const base = `http://127.0.0.1:${registry.address().port}`;
    if (request.url === `/${pkg.name}`) {
      const version = { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, peerDependencies: pkg.peerDependencies,
        pi: pkg.pi, keywords: pkg.keywords, dist: { tarball: `${base}/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`, integrity, shasum } };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ name: pkg.name, "dist-tags": { latest: pkg.version }, versions: { [pkg.version]: version } }));
      return;
    }
    if (request.url === `/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`) { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end(tarballBytes); return; }
    try {
      const upstream = await fetch(`${UPSTREAM}${request.url}`, { headers: { accept: request.headers.accept ?? "application/json" } });
      response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream" });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(502); response.end(); }
  });
  await new Promise(done => registry.listen(0, "127.0.0.1", done));
  const registryUrl = `http://127.0.0.1:${registry.address().port}/`;

  let installed;
  await check("pi install npm:pi-pane into a clean agent directory and npm cache installs without building", async () => {
    fixture = await startFixture({ packaged: true, async prepareAgentDir(agentDir, directory) {
      const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
      const env = { PATH: process.env.PATH, HOME: join(directory, "home"), PI_CODING_AGENT_DIR: agentDir,
        npm_config_registry: registryUrl, npm_config_cache: join(directory, "npm-cache"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
      await mkdir(env.HOME);
      const started = Date.now();
      const { stdout, stderr } = await run(process.execPath, [cli, "install", `npm:${pkg.name}@${pkg.version}`], { env, cwd: directory, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
      const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      installed = { durationMs: Date.now() - started, packages: settings.packages, output: `${stdout}${stderr}`.trim().slice(-400) };
    } });
    assert.ok(installed.packages.some(entry => String(typeof entry === "string" ? entry : entry.source).startsWith(`npm:${pkg.name}`)), "settings declare the package");
    assert.ok(requests.includes(`/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`), "the tarball came from the registry");
    const { stdout } = await run("find", [fixture.agentDir, "-path", `*node_modules/${pkg.name}/package.json`, "-not", "-path", "*/node_modules/*/node_modules/*"]);
    const root = dirname(stdout.trim().split("\n")[0]);
    const names = await readdir(join(root, ".."));
    for (const devOnly of ["vite", "playwright", "typescript", "preact", "shiki"]) assert.ok(!names.includes(devOnly), `${devOnly} is not installed`);
    for (const runtime of ["ws", "qrcode-generator"]) assert.ok(names.includes(runtime), `${runtime} is installed`);
    assert.ok((await stat(join(root, "web-dist/index.html"))).isFile(), "prebuilt web assets are installed");
    installed.root = root.replace(fixture.agentDir, "<agentDir>");
    return installed;
  });

  await check("the installed package starts with --web and serves its own prebuilt page to Chrome", async () => {
    await waitFor(() => fixture.url, "web URL from the installed package", 30_000);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    const html = await (await fetch(new URL("/", fixture.url))).text();
    const packaged = await run("tar", ["-xOzf", tarball, "package/web-dist/index.html"]);
    assert.equal(html, packaged.stdout, "the page is the one from the tarball");
    await page.goto(fixture.url);
    await page.getByText("已连接", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "消息" }).fill("M2_INSTALLED");
    await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
    await page.locator(".message-assistant").filter({ hasText: "M0_REPLY:M2_INSTALLED:complete" }).waitFor();
    assert.deepEqual(errors, []);
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]");
  if (fixture) report.terminalTail = fixture.terminal.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").slice(-3000);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (fixture) { await fixture.close(); await fixture.remove(); }
  await new Promise(done => registry ? registry.close(() => done()) : done());
  await rm(work, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${join(reportDir, "report.json")}`);
}
