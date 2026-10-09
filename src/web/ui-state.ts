/** Full UI state snapshots also carry status changes; only a new editor revision replaces the draft. */
export class EditorChangeGuard {
  private applied?: { epoch: string; revision: number };
  read(epoch: string, ui: { editorRevision?: number; editorText?: string }): string | undefined {
    if (typeof ui.editorText !== "string" || !Number.isSafeInteger(ui.editorRevision) || ui.editorRevision! < 0) return;
    if (this.applied?.epoch === epoch && this.applied.revision >= ui.editorRevision!) return;
    this.applied = { epoch, revision: ui.editorRevision! };
    return ui.editorText;
  }
}

/** Extension display strings often use TUI theme colors; terminal control sequences are not HTML. */
export function extensionText(value: string): string {
  return value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
