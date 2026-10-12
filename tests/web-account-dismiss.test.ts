import assert from "node:assert/strict";
import test from "node:test";
import type { AccountOperation } from "../src/protocol/index.js";

const key = "pi-pane.accountDismissed";
const previousId = "a18c8eaf-01d4-478b-85f4-72544d4d66a9";
const values = new Map([[key, previousId]]);
const storage = {
  getItem: (name: string) => values.get(name) ?? null,
  setItem: (name: string, value: string) => { values.set(name, value); },
  removeItem: (name: string) => { values.delete(name); },
};
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
const { dismissAccount, webStore } = await import("../src/web/store.js");
const operation = (status: AccountOperation["status"]): AccountOperation => ({
  id: "5f66b1d3-7ed5-420d-bd12-fc5a61da2b40", providerId: "fixture", providerName: "Fixture provider",
  method: "api_key", status, owner: true, startedAt: 1, expiresAt: 2,
});

test("a closed account result remains dismissed when a fresh page restores the tab's state", () => {
  assert.equal(webStore.getState().accountDismissed, previousId);
  const saved = operation("saved");
  webStore.setState({ account: saved });
  dismissAccount(saved.id);
  assert.deepEqual([...values], [[key, saved.id]], "storage contains only the non-sensitive operation ID");
  assert.equal(webStore.getState().accountDismissed, saved.id);
  dismissAccount("");
  assert.equal(values.has(key), false);
  assert.equal(webStore.getState().accountDismissed, "");
});

test("folding a running login does not hide its step after refresh", () => {
  values.set(key, previousId);
  const running = operation("running");
  webStore.setState({ account: running });
  dismissAccount(running.id);
  assert.equal(webStore.getState().accountDismissed, running.id, "the current page can fold the dialog");
  assert.equal(values.has(key), false, "a newly loaded page will show the in-progress login again");
});

test("closing a result still works when tab storage is unavailable", () => {
  const saved = operation("saved");
  webStore.setState({ account: saved, accountDismissed: "" });
  const set = storage.setItem;
  storage.setItem = () => { throw new Error("Storage is blocked"); };
  try {
    assert.doesNotThrow(() => dismissAccount(saved.id));
    assert.equal(webStore.getState().accountDismissed, saved.id);
  } finally { storage.setItem = set; }
});
