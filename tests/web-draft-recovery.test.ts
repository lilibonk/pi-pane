import assert from "node:assert/strict";
import { test } from "node:test";
import { TreeDraftRecovery } from "../src/web/draft-recovery.js";

const source = { id: "session-a", branchRevision: 4 };
const destination = { id: "session-a", branchRevision: 5 };
const result = { cancelled: false, sessionId: destination.id, branchRevision: destination.branchRevision, draftText: "original message" };

test("tree input recovery joins snapshot and result in either arrival order, only once", () => {
  for (const first of ["snapshot", "result"]) {
    const recovery = new TreeDraftRecovery();
    recovery.start("tree-1", source, 2);
    if (first === "snapshot") {
      assert.equal(recovery.reconcile(destination, "", 2), undefined);
      recovery.complete("tree-1", result);
    } else {
      recovery.complete("tree-1", result);
      assert.equal(recovery.reconcile(source, "", 2), undefined);
    }
    assert.deepEqual(recovery.reconcile(destination, "", 2), { text: result.draftText, restore: true });
    recovery.complete("tree-1", result);
    assert.equal(recovery.reconcile(destination, "", 2), undefined);
  }
});

test("tree recovery preserves any existing or subsequently edited draft", () => {
  for (const [draft, revision] of [["new message", 2], [" ", 2], ["", 3]] as const) {
    const recovery = new TreeDraftRecovery();
    recovery.start("tree-1", source, 2);
    recovery.complete("tree-1", result);
    assert.deepEqual(recovery.reconcile(destination, draft, revision), { text: result.draftText, restore: false });
  }
});

test("old, cancelled, queried or superseded tree results cannot recover into another destination", () => {
  const recovery = new TreeDraftRecovery();
  recovery.start("tree-1", source, 0);
  recovery.complete("old-tree", result);
  assert.equal(recovery.reconcile(destination, "", 0), undefined);
  recovery.cancel("tree-1");
  recovery.complete("tree-1", result);
  assert.equal(recovery.reconcile(destination, "", 0), undefined);

  recovery.start("tree-2", source, 0);
  recovery.complete("tree-2", { ...result, cancelled: true });
  assert.equal(recovery.reconcile(destination, "", 0), undefined);

  recovery.start("tree-3", source, 0);
  assert.equal(recovery.reconcile({ ...destination, id: "session-b" }, "", 0), undefined);
  recovery.complete("tree-3", result);
  assert.equal(recovery.reconcile(destination, "", 0), undefined);

  recovery.start("tree-4", source, 0);
  recovery.complete("tree-4", result);
  assert.equal(recovery.reconcile({ ...destination, branchRevision: 6 }, "", 0), undefined);
  assert.equal(recovery.reconcile(destination, "", 0), undefined);
});
