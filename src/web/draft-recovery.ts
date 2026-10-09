import type { SessionMutationResult } from "../protocol/workbench.js";

export interface DraftScope { id: string; branchRevision: number }
/** A tree reply may arrive either side of its snapshot. Only the initiating live operation may restore. */
export class TreeDraftRecovery {
  private pending?: { id: string; source: DraftScope; draftRevision: number; result?: SessionMutationResult };

  start(id: string, source: DraftScope, draftRevision: number) {
    this.pending = { id, source, draftRevision };
  }
  cancel(id?: string) { if (!id || this.pending?.id === id) this.pending = undefined; }
  complete(id: string, result: SessionMutationResult) {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.result) return;
    if (result.cancelled || typeof result.draftText !== "string" || result.sessionId !== pending.source.id ||
        !Number.isSafeInteger(result.branchRevision) || result.branchRevision! < pending.source.branchRevision) {
      this.cancel(id); return;
    }
    pending.result = result;
  }
  reconcile(scope: DraftScope, draft: string, draftRevision: number): { text: string; restore: boolean } | undefined {
    const pending = this.pending;
    if (!pending) return;
    if (scope.id !== pending.source.id) { this.cancel(); return; }
    const result = pending.result;
    if (!result) return;
    if (scope.branchRevision > result.branchRevision!) { this.cancel(); return; }
    if (scope.branchRevision !== result.branchRevision) return;
    this.cancel();
    return { text: result.draftText!, restore: draft === "" && draftRevision === pending.draftRevision };
  }
}
