import type { SessionMutationResult } from "../protocol/workbench.js";

export interface DraftScope { id: string; branchRevision: number }
/** Join the initiating RPC fork receipt and destination snapshot, in either arrival order. */
export class ForkDraftRecovery {
  private pending?: { id: string; source: DraftScope; draftRevision: number; result?: SessionMutationResult };
  start(id: string, source: DraftScope, draftRevision: number) { this.pending = { id, source, draftRevision }; }
  cancel(id?: string) { if (!id || this.pending?.id === id) this.pending = undefined; }
  complete(id: string, result: SessionMutationResult) {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.result) return;
    if (result.cancelled || typeof result.draftText !== "string" || !result.sessionId ||
        !Number.isSafeInteger(result.branchRevision) || result.branchRevision! < 0) { this.cancel(id); return; }
    pending.result = result;
  }
  reconcile(scope: DraftScope, draft: string, draftRevision: number): { text: string; restore: boolean } | undefined {
    const pending = this.pending, result = pending?.result;
    if (!pending || !result) return;
    if (scope.id === pending.source.id && scope.id !== result.sessionId) return;
    if (scope.id !== result.sessionId || scope.branchRevision > result.branchRevision!) { this.cancel(); return; }
    if (scope.branchRevision !== result.branchRevision) return;
    this.cancel();
    return { text: result.draftText!, restore: draft === "" && draftRevision === pending.draftRevision };
  }
}
