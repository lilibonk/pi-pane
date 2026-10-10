/**
 * Unsent composer content belongs to the project it was written in. A file reference or pasted
 * excerpt from one directory must not be sent into another just because the project changed.
 * Memory only: a reload starts with an empty composer, as before.
 */
export class ProjectDrafts<A> {
  private readonly stash = new Map<string, { draft: string; attachments: A[] }>();
  private project?: string;
  constructor(private readonly limit = 16, private readonly discard: (attachments: A[]) => void = () => {}) {}
  /**
   * Called with the project of every snapshot. When the project changed, the current content is
   * kept for the project being left and the returned content (its own, or empty) replaces it.
   */
  enter(project: string, current: { draft: string; attachments: A[] }): { draft: string; attachments: A[] } | undefined {
    const previous = this.project;
    this.project = project;
    if (previous === undefined || previous === project) return undefined;
    this.stash.delete(previous);
    if (current.draft || current.attachments.length) this.stash.set(previous, current);
    while (this.stash.size > this.limit) {
      const oldest = this.stash.keys().next().value!;
      this.discard(this.stash.get(oldest)!.attachments); this.stash.delete(oldest);
    }
    const restored = this.stash.get(project) ?? { draft: "", attachments: [] };
    this.stash.delete(project);
    return restored;
  }
}
