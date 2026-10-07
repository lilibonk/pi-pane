#!/usr/bin/env node
/** Lightweight real-TUI checks of persisted messages that lack extension events. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openClient, startFixture, textOf, waitFor } from "./m0-smoke.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.env.PI_M0_PROJECTION_REPORT_DIR || join(project, "build-artifacts/m0/projection-extra"));
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), piVersion: "1.0.4", realTui: true, realModelCalls: 0, checks: [] };
const redact = (value) => String(value).replace(/#t=[A-Za-z0-9_-]+/g, "#t=[REDACTED]");
let fixture, first, second, restored;
try {
  fixture = await startFixture({ extraExtensions: [join(project, "tests/fixtures/projection-extra.ts")] });
  first = await openClient(fixture.url); second = await openClient(fixture.url);
  const epoch = first.snapshot.epoch;
  fixture.command("/m0-projection-visible");
  const appended = await fixture.waitEvent("projection_entries_appended");
  assert.equal(appended.idle, true);
  await waitFor(() => [first, second].every((client) => client.snapshot.session.messages.some((message) => textOf(message) === "M0_IDLE_VISIBLE")), "idle custom entry reaches both viewers", 1000);
  const convergenceMs = Date.now() - appended.at;
  assert.ok(convergenceMs < 1000);
  for (const client of [first, second]) {
    assert.equal(client.snapshot.epoch, epoch);
    assert.equal(client.snapshot.state.idle, true);
    assert.doesNotMatch(JSON.stringify(client.frames), /M0_PRIVATE_DETAILS|M0_HIDDEN_MESSAGE|M0_PRIVATE_ENTRY/);
  }
  assert.equal((await fixture.events()).filter((event) => event.event === "provider_call").length, 0);
  report.checks.push({ name: "idle visible custom entry reaches two connected viewers without resync or model turns", status: "passed", convergenceMs,
    hiddenAndOpaqueDataAbsent: true, sameEpoch: true });

  const bangStarted = Date.now();
  fixture.command("!printf M0_BASH_VISIBLE");
  await waitFor(() => [first, second].every((client) => client.snapshot.session.messages.some((message) => message.role === "bashExecution" && textOf(message).endsWith("\nM0_BASH_VISIBLE"))), "real TUI bang execution output is projected", 5000);
  const bash = first.snapshot.session.messages.find((message) => message.role === "bashExecution");
  assert.equal(textOf(bash), "$ printf M0_BASH_VISIBLE\n[Exit code: 0]\nM0_BASH_VISIBLE");
  assert.equal(first.snapshot.epoch, epoch);
  restored = await openClient(fixture.url);
  assert.deepEqual(restored.snapshot.session.messages.map((message) => [message.id, message.role, textOf(message)]),
    first.snapshot.session.messages.map((message) => [message.id, message.role, textOf(message)]));
  report.checks.push({ name: "real TUI bang command, exit code and output match a fresh snapshot", status: "passed", durationMs: Date.now() - bangStarted,
    sameMessageIds: true, sameEpoch: true });
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = redact(error.stack ?? error); process.exitCode = 1;
} finally {
  for (const client of [first, second, restored]) await client?.close();
  if (fixture) {
    await fixture.close();
    await writeFile(join(output, "fixture-events.jsonl"), await readFile(fixture.eventPath));
    await writeFile(join(output, "terminal.redacted.log"), redact(fixture.terminal + fixture.processError));
    await fixture.remove();
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
