#!/usr/bin/env node
// A11 (install): the npm tarball contains the prebuilt extension and web assets; `pi install npm:@lilibonk/pi-pane@<version>`
// into a clean agent directory and npm cache installs it without a build; the installed package serves /web.
// By default, a local registry serves this package's tarball and proxies other packages to public npm.
// PI_M2_PUBLISHED_TARBALL=/absolute/package.tgz skips packing and verifies installation from public npm.
// PI_M2_CANDIDATE_TARBALL=/absolute/package.tgz installs that frozen candidate through the local registry.
// Gallery listing and real-provider conversations are not covered by this deterministic installation test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { readPiHost, startFixture, waitFor } from "./m0-smoke.mjs";

const execute = promisify(execFile);
const run = (command, args, options = {}) => execute(command, args, { env: { PATH: process.env.PATH, HOME: work, NPM_CONFIG_USERCONFIG: join(work, "empty-user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(work, "empty-global.npmrc"), NPM_CONFIG_CACHE: join(work, "npm-cache") }, ...options });
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = await readPiHost();
const reportDir = resolve(process.env.PI_M2_REPORT_DIR ?? join(project, "build-artifacts/m3/handoff/m2/install"));
await mkdir(reportDir, { recursive: true });
const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const UPSTREAM = "https://registry.npmjs.org";
const publishedTarball = process.env.PI_M2_PUBLISHED_TARBALL;
const candidateTarball = process.env.PI_M2_CANDIDATE_TARBALL;
assert.ok(!(publishedTarball && candidateTarball), "Select either a candidate or a published tarball, not both");
const suppliedTarball = publishedTarball || candidateTarball;
const mode = publishedTarball ? "published" : "simulated";
const report = { scope: "A11 install: npm tarball contents and pi install from a registry into a clean agent directory", mode,
  registry: publishedTarball ? `${UPSTREAM}/` : "temporary local registry (proxies other packages to public npm)",
  provider: "pi-pane-m0/deterministic (no provider credentials)", piVersion: host.version, piCli: host.cli, checks: [], status: "running",
  notCovered: [...(publishedTarball ? [] : ["Publication to npmjs.com (this run uses a simulated registry)"]), "Listing in the pi.dev gallery", "Real-provider model conversations"] };
const redact = value => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]").replace(/pi-pane\.bearer\.[A-Za-z0-9_-]+/g, "pi-pane.bearer.[REDACTED]");
const check = async (name, action) => {
  const started = Date.now();
  try {
    const details = await action();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: redact(error?.stack ?? error) });
    console.log(`FAIL ${name}: ${redact(error)}`);
    throw error;
  }
};

const work = await mkdtemp(join(tmpdir(), "pi-pane-m2-install-"));
let registry, fixture, browser;
try {
  await writeFile(join(work, "empty-user.npmrc"), "", { mode: 0o600 });
  await writeFile(join(work, "empty-global.npmrc"), "", { mode: 0o600 });
  let tarball, tarballBytes, files, manifest;
  await check("the npm tarball carries the prebuilt extension and web assets, and no sources or tests", async () => {
    let info;
    if (suppliedTarball) {
      assert.ok(isAbsolute(suppliedTarball), "The supplied tarball must be an absolute path");
      tarball = suppliedTarball;
      assert.ok((await stat(tarball)).isFile(), "the supplied tarball exists");
      const { stdout } = await run("tar", ["-tzf", tarball], { maxBuffer: 16 * 1024 * 1024 });
      const entries = stdout.trim().split("\n").filter(Boolean);
      for (const entry of entries) assert.ok(entry.startsWith("package/") && !entry.split("/").includes(".."), `unexpected tarball entry ${entry}`);
      files = entries.filter(entry => !entry.endsWith("/")).map(entry => entry.slice("package/".length));
    } else {
      // The caller builds once before this matrix. Pack existing prebuilt assets without
      // running another concurrent build or reading the maintainer's npm configuration.
      const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", work], { cwd: project, maxBuffer: 16 * 1024 * 1024 });
      info = JSON.parse(stdout.slice(stdout.indexOf("[")))[0];
      tarball = join(work, info.filename);
      files = info.files.map(file => file.path);
    }
    tarballBytes = await readFile(tarball);
    for (const required of ["package.json", "README.md", "dist/extension/index.js", "dist/extension/theme.js", "dist/protocol/index.js", "web-dist/index.html", "web-dist/pi-pane.css", "themes/pi-pane-dark.json", "themes/pi-pane-light.json"]) assert.ok(files.includes(required), required);
    assert.ok(files.some(file => /^web-dist\/assets\/index-.*\.js$/.test(file)), "web bundle");
    assert.ok(files.some(file => /^web-dist\/assets\/index-.*\.css$/.test(file)), "web styles");
    for (const file of files) assert.ok(!/^(src|tests|scripts|build-artifacts|node_modules)\//.test(file), `unexpected ${file}`);
    const packedManifest = await run("tar", ["-xOzf", tarball, "package/package.json"]);
    manifest = JSON.parse(packedManifest.stdout);
    assert.equal(manifest.name, pkg.name, "the tarball is for this package");
    assert.equal(manifest.version, pkg.version, "the tarball is the local release version");
    assert.deepEqual(manifest.pi.extensions, ["./dist/extension/index.js"]);
    assert.ok(manifest.pi.themes.includes("./themes/*.json"), "bundled themes are discoverable by pi");
    assert.ok(manifest.keywords.includes("pi-package"));
    report.package = { name: manifest.name, version: manifest.version };
    return { filename: basename(tarball), packedBytes: tarballBytes.length, ...(info ? { unpackedBytes: info.unpackedSize } : {}), files: files.length, packing: suppliedTarball ? `skipped (supplied ${publishedTarball ? "published" : "candidate"} tarball)` : "npm pack --ignore-scripts after caller build" };
  });

  const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  const shasum = createHash("sha1").update(tarballBytes).digest("hex");
  report.archive = { filename: basename(tarball), sha256: createHash("sha256").update(tarballBytes).digest("hex"), integrity, shasum };
  const requests = [];
  let registryUrl = `${UPSTREAM}/`;
  if (publishedTarball) {
    await check("the public npm registry publishes the selected version with the supplied tarball's integrity", async () => {
      const registryName = encodeURIComponent(manifest.name).replace(/^%40/, "@");
      const metadataUrl = `${UPSTREAM}/${registryName}/${encodeURIComponent(manifest.version)}`;
      const response = await fetch(metadataUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200, "published version is available from public npm");
      assert.equal(new URL(response.url).origin, UPSTREAM, "metadata comes from public npm");
      const metadata = await response.json();
      assert.equal(metadata.name, manifest.name);
      assert.equal(metadata.version, manifest.version);
      assert.equal(metadata.dist?.integrity, integrity, "public npm integrity matches the supplied tarball bytes");
      assert.equal(new URL(metadata.dist.tarball).origin, UPSTREAM, "public npm serves the published tarball");
      return { name: metadata.name, version: metadata.version, registry: registryUrl, integrity, tarball: metadata.dist.tarball };
    });
  } else {
    // Simulated registry: this package from the tarball, everything else proxied.
    const tarballPath = `/${pkg.name}/-/${basename(pkg.name)}-${pkg.version}.tgz`;
    registry = createServer(async (request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      requests.push(pathname);
      const base = `http://127.0.0.1:${registry.address().port}`;
      if (pathname === `/${pkg.name}`) {
        const version = { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, peerDependencies: pkg.peerDependencies,
          pi: pkg.pi, keywords: pkg.keywords, dist: { tarball: `${base}${tarballPath}`, integrity, shasum } };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ name: pkg.name, "dist-tags": { latest: pkg.version }, versions: { [pkg.version]: version } }));
        return;
      }
      if (pathname === tarballPath) { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end(tarballBytes); return; }
      try {
        const upstream = await fetch(`${UPSTREAM}${request.url}`, { headers: { accept: request.headers.accept ?? "application/json" } });
        response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream" });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end(); }
    });
    await new Promise(done => registry.listen(0, "127.0.0.1", done));
    registryUrl = `http://127.0.0.1:${registry.address().port}/`;
  }

  let installed, installedRoot;
  await check(`pi install npm:${pkg.name} from the ${mode} registry into a clean agent directory, HOME and npm cache installs without building`, async () => {
    fixture = await startFixture({ cli: host.cli, packaged: true, loadThemes: true, extraExtensions: [join(project, "tests/fixtures/performance-provider.ts")], async prepareAgentDir(agentDir, directory) {
      // On macOS /var aliases /private/var. npm lock keys require a canonical install prefix.
      const installDirectory = await realpath(directory);
      const installAgentDir = await realpath(agentDir);
      const env = { PATH: process.env.PATH, HOME: join(installDirectory, "home"), PI_CODING_AGENT_DIR: installAgentDir,
        npm_config_registry: registryUrl, npm_config_cache: join(installDirectory, "npm-cache"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false",
        npm_config_userconfig: join(installDirectory, "empty-user.npmrc"), npm_config_globalconfig: join(installDirectory, "empty-global.npmrc") };
      await mkdir(env.HOME);
      // Empty task-owned configs prevent npm from reading maintainer credentials or registry settings.
      await writeFile(env.npm_config_userconfig, "", { mode: 0o600 });
      await writeFile(env.npm_config_globalconfig, "", { mode: 0o600 });
      const started = Date.now();
      const { stdout, stderr } = await run(process.execPath, [host.cli, "install", `npm:${pkg.name}@${pkg.version}`], { env, cwd: installDirectory, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
      const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      installed = { durationMs: Date.now() - started, mode, registry: registryUrl, packages: settings.packages, output: redact(`${stdout}${stderr}`).trim().slice(-400) };
    } });
    assert.ok(installed.packages.some(entry => (typeof entry === "string" ? entry : entry.source) === `npm:${pkg.name}@${pkg.version}`), "settings declare the selected package and version");
    if (!publishedTarball) assert.ok(requests.includes(`/${pkg.name}/-/${basename(pkg.name)}-${pkg.version}.tgz`), "the tarball came from the simulated registry");
    const { stdout } = await run("find", [fixture.agentDir, "-path", `*node_modules/${pkg.name}/package.json`, "-not", "-path", "*/node_modules/*/node_modules/*"]);
    const manifests = stdout.trim().split("\n").filter(Boolean);
    assert.equal(manifests.length, 1, "one top-level installation of the selected package exists");
    const root = dirname(manifests[0]);
    // Scoped packages live one directory deeper: node_modules/@scope/package.
    const modulesRoot = manifest.name.startsWith("@") ? dirname(dirname(root)) : dirname(root);
    installedRoot = root;
    assert.deepEqual(JSON.parse(await readFile(join(root, "package.json"), "utf8")), manifest, "the registry installed the selected package manifest");
    if (publishedTarball) {
      const lockPath = join(dirname(modulesRoot), "package-lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      const lockKey = `node_modules/${manifest.name}`;
      const installedPackage = lock.packages[lockKey];
      report.installation = { ...installed, lock: { path: lockPath.replace(fixture.agentDir, "<agentDir>"), lockfileVersion: lock.lockfileVersion,
        key: lockKey, packageKeys: Object.keys(lock.packages), selectedPackage: installedPackage ?? null } };
      assert.equal(installedPackage?.version, manifest.version, "npm installed the selected published version");
      assert.equal(installedPackage?.integrity, integrity, "the npm lock records the published tarball integrity");
      assert.equal(new URL(installedPackage.resolved).origin, UPSTREAM, "npm downloaded the package from public npm");
      installed.tarball = installedPackage.resolved;
      installed.integrity = installedPackage.integrity;
    }
    const names = await readdir(modulesRoot);
    for (const devOnly of ["vite", "playwright", "typescript", "preact", "shiki"]) assert.ok(!names.includes(devOnly), `${devOnly} is not installed`);
    for (const runtime of ["ws", "qrcode-generator"]) assert.ok(names.includes(runtime), `${runtime} is installed`);
    assert.ok((await stat(join(root, "web-dist/index.html"))).isFile(), "prebuilt web assets are installed");
    installed.root = root.replace(fixture.agentDir, "<agentDir>");
    return installed;
  });

  await check("the installed package hands its saved TUI session to /web and serves its own prebuilt page to Chrome", async () => {
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
    await page.reload();
    await page.getByText("已连接", { exact: true }).waitFor();
    await page.locator(".message-assistant").filter({ hasText: "M0_REPLY:M2_INSTALLED:complete" }).waitFor();
    assert.equal(await page.locator(".message-assistant").filter({ hasText: "M0_REPLY:M2_INSTALLED:complete" }).count(), 1, "refresh restores the reply once");
    await page.getByRole("textbox", { name: "消息" }).fill("M2_INSTALLED_RECONNECTED");
    await page.getByRole("button", { name: /^(发送 ↗|请求 followUp ↗)$/ }).click();
    await page.locator(".message-assistant").filter({ hasText: "M0_REPLY:M2_INSTALLED_RECONNECTED:complete" }).waitFor();
    assert.deepEqual(errors, []);
  });
  await check("the installed package loads bundled themes and a local CSS override without rebuilding", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.getByText("已连接", { exact: true }).waitFor();
    for (const name of ["pi-pane-dark", "pi-pane-light"]) {
      const theme = JSON.parse(await readFile(join(installedRoot, "themes", `${name}.json`), "utf8"));
      assert.equal(theme.name, name);
      assert.ok(theme.export.pageBg);
      assert.ok(theme.colors && theme.vars, "both bundled theme definitions are valid installed assets");
    }
    // Theme mutation has no public RPC method; the handoff's initial theme is retained.
    assert.ok(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().length > 0));
    await writeFile(join(installedRoot, "web-dist/pi-pane.css"), ':root { font-family: monospace; } .composer { border-radius: 19px; }\n');
    await page.reload();
    await page.getByText("已连接", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".composer")).borderRadius), "19px");
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily), "monospace");
    await page.close();
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = redact(error?.stack ?? error);
  if (fixture) report.terminalTail = redact(fixture.terminal.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")).slice(-3000);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (fixture) { await fixture.close(); await fixture.remove(); }
  await new Promise(done => registry ? registry.close(() => done()) : done());
  await rm(work, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report (${mode} registry): ${join(reportDir, "report.json")}`);
}
