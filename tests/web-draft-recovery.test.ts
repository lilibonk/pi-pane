import assert from "node:assert/strict";
import { test } from "node:test";
import { ForkDraftRecovery } from "../src/web/draft-recovery.js";

const source = { id: "session-a", branchRevision: 4 };
const destination = { id: "session-fork", branchRevision: 0 };
const result = { cancelled: false, sessionId: destination.id, branchRevision: destination.branchRevision, draftText: "original message" };

test("RPC fork draft joins a new session snapshot and receipt in either arrival order, only once", () => {
  for (const first of ["snapshot", "result"]) {
    const recovery = new ForkDraftRecovery();
    recovery.start("fork-1", source, 2);
    if (first === "snapshot") {
      assert.equal(recovery.reconcile(destination, "", 2), undefined);
      recovery.complete("fork-1", result);
    } else {
      recovery.complete("fork-1", result);
      assert.equal(recovery.reconcile(source, "", 2), undefined);
    }
    assert.deepEqual(recovery.reconcile(destination, "", 2), { text: result.draftText, restore: true });
    recovery.complete("fork-1", result);
    assert.equal(recovery.reconcile(destination, "", 2), undefined);
  }
});

test("RPC fork recovery preserves any existing or subsequently edited draft", () => {
  for (const [draft, revision] of [["new message", 2], [" ", 2], ["", 3]] as const) {
    const recovery = new ForkDraftRecovery();
    recovery.start("fork-1", source, 2);
    recovery.complete("fork-1", result);
    assert.deepEqual(recovery.reconcile(destination, draft, revision), { text: result.draftText, restore: false });
  }
});

test("old, cancelled, queried or superseded fork results cannot recover into another destination", () => {
  const recovery = new ForkDraftRecovery();
  recovery.start("fork-1", source, 0);
  recovery.complete("old-fork", result);
  assert.equal(recovery.reconcile(destination, "", 0), undefined);
  recovery.cancel("fork-1");
  recovery.complete("fork-1", result);
  assert.equal(recovery.reconcile(destination, "", 0), undefined);
  recovery.start("fork-2", source, 0);
  recovery.complete("fork-2", { ...result, cancelled: true });
  assert.equal(recovery.reconcile(destination, "", 0), undefined);
  recovery.start("fork-3", source, 0);
  recovery.complete("fork-3", result);
  assert.equal(recovery.reconcile({ ...destination, id: "session-b" }, "", 0), undefined);
  assert.equal(recovery.reconcile(destination, "", 0), undefined);
  recovery.start("fork-4", source, 0);
  recovery.complete("fork-4", result);
  assert.equal(recovery.reconcile({ ...destination, branchRevision: 1 }, "", 0), undefined);
  assert.equal(recovery.reconcile(destination, "", 0), undefined);
});
