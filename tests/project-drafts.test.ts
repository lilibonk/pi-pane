import test from "node:test";
import assert from "node:assert/strict";
import { ProjectDrafts } from "../src/web/project-drafts.js";
import { parseClientMessage } from "../src/protocol/index.js";

test("unsent text and attachments stay with the project they were written in", () => {
  const drafts = new ProjectDrafts<string>();
  assert.equal(drafts.enter("/a", { draft: "", attachments: [] }), undefined);
  // Another session of the same project keeps the composer as it is.
  assert.equal(drafts.enter("/a", { draft: "see @src/app.ts", attachments: ["shot.png"] }), undefined);
  // A file reference written for /a is not carried into /b.
  assert.deepEqual(drafts.enter("/b", { draft: "see @src/app.ts", attachments: ["shot.png"] }), { draft: "", attachments: [] });
  assert.deepEqual(drafts.enter("/a", { draft: "for b", attachments: [] }), { draft: "see @src/app.ts", attachments: ["shot.png"] });
  assert.deepEqual(drafts.enter("/b", { draft: "", attachments: [] }), { draft: "for b", attachments: [] });
  // An emptied composer leaves nothing behind.
  assert.deepEqual(drafts.enter("/a", { draft: "", attachments: [] }), { draft: "", attachments: [] });
  assert.deepEqual(drafts.enter("/b", { draft: "", attachments: [] }), { draft: "", attachments: [] });
});
test("kept drafts are bounded and evicted attachments are released", () => {
  const released: string[] = []; const drafts = new ProjectDrafts<string>(2, attachments => released.push(...attachments));
  drafts.enter("/p0", { draft: "", attachments: [] });
  for (let index = 1; index <= 4; index++) drafts.enter(`/p${index}`, { draft: `draft ${index - 1}`, attachments: [`image ${index - 1}`] });
  assert.deepEqual(released, ["image 0", "image 1"]);
  assert.deepEqual(drafts.enter("/p0", { draft: "", attachments: [] }), { draft: "", attachments: [] });
  assert.deepEqual(drafts.enter("/p3", { draft: "", attachments: [] }), { draft: "draft 3", attachments: ["image 3"] });
});
test("host queries and project commands accept only their own typed arguments", () => {
  const command = (name: string, args: unknown, extra: Record<string, unknown> = {}) => ({ t: "host_command", clientId: "c", commandNo: 1, id: "c:1", hostRevision: 0, command: name, args, ...extra });
  for (const valid of [command("project_open", { path: "/a b/中文" }), command("project_open", { path: "/a", trust: "withhold" }), command("project_create", { parent: "/a", name: "$(x) `y`" }),
    command("project_remove", { path: "/a" }), command("project_relocate", { from: "/a", to: "/b" }), command("host_stop", {}),
    { t: "host_query", reqId: "r", action: "projects", args: {} }, { t: "host_query", reqId: "r", action: "directories", args: {} }, { t: "host_query", reqId: "r", action: "directories", args: { path: "/" } },
    { t: "host_query", reqId: "r", action: "project_inspect", args: { path: "/a" } }]) assert.doesNotThrow(() => parseClientMessage(valid), JSON.stringify(valid));
  for (const invalid of [command("project_open", { path: "relative" }), command("project_open", { path: "/a\0b" }), command("project_open", { path: "/a", trust: "approve" }), command("project_open", { path: "/a", session: "/x.jsonl" }),
    command("project_open", { path: `/${"a".repeat(4096)}` }), command("project_create", { parent: "/a" }), command("project_create", { parent: "/a", name: "x", recursive: true }), command("project_remove", {}),
    command("project_relocate", { from: "/a" }), command("host_stop", { now: true }), command("exec", { cmd: "ls" }), command("project_open", { path: "/a" }, { cwd: "/x" }),
    { t: "host_query", reqId: "r", action: "file", args: { path: "/etc/passwd" } }, { t: "host_query", reqId: "r", action: "directories", args: { path: "~" } }, { t: "host_query", reqId: "r", action: "projects", args: { all: true } },
    { t: "host_query", reqId: "r", action: "project_inspect", args: {} }, { t: "host_query", reqId: "r", action: "directories", args: { path: "/", files: true } }]) assert.throws(() => parseClientMessage(invalid), JSON.stringify(invalid));
});
