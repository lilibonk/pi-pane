export interface DiffPart { text: string; changed: boolean }
export interface DiffLine {
  kind: "meta" | "hunk" | "add" | "del" | "context";
  parts: DiffPart[];
}

// Expanded tool results can be large; word matching must not stall the timeline.
export const DIFF_LIMITS = { characters: 131_072, tokensPerSide: 2_048, matrixCells: 250_000 } as const;

interface Token { text: string; start: number; changed: boolean }
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "word" }) : undefined;

function tokens(text: string): Token[] | undefined {
  const result: Token[] = [];
  const segments = segmenter?.segment(text);
  if (segments) {
    for (const segment of segments) {
      if (result.length === DIFF_LIMITS.tokensPerSide) return undefined;
      result.push({ text: segment.segment, start: segment.index, changed: true });
    }
  } else {
    const pattern = /\p{Script=Han}|[\p{L}\p{M}\p{N}_]+|[^\S\r\n]+|\r\n|[\r\n]|./gu;
    for (const match of text.matchAll(pattern)) {
      if (result.length === DIFF_LIMITS.tokensPerSide) return undefined;
      result.push({ text: match[0], start: match.index!, changed: true });
    }
  }
  return result;
}

function append(parts: DiffPart[], text: string, changed: boolean): void {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.changed === changed) last.text += text;
  else parts.push({ text, changed });
}

function decorate(lines: DiffLine[], indexes: number[], words: Token[]): void {
  let offset = 0;
  let tokenIndex = 0;
  for (const index of indexes) {
    const line = lines[index]!;
    const source = line.parts[0]!.text;
    const end = offset + source.length - 1;
    const parts: DiffPart[] = [{ text: source[0]!, changed: false }];
    while (tokenIndex < words.length) {
      const token = words[tokenIndex]!;
      const tokenEnd = token.start + token.text.length;
      if (token.start >= end) break;
      if (tokenEnd > offset) append(parts, token.text.slice(Math.max(0, offset - token.start), Math.min(token.text.length, end - token.start)), token.changed);
      if (tokenEnd > end) break;
      tokenIndex++;
    }
    line.parts = parts;
    offset = end + 1;
  }
}

function matchWords(oldWords: Token[], newWords: Token[]): void {
  const width = newWords.length + 1;
  const lengths = new Uint32Array((oldWords.length + 1) * width);
  for (let i = oldWords.length - 1; i >= 0; i--) {
    // Repeated indentation must not displace matching identifiers or words.
    const weight = /\S/u.test(oldWords[i]!.text) ? Math.min(32, oldWords[i]!.text.length) + 2 : 1;
    for (let j = newWords.length - 1; j >= 0; j--) {
      lengths[i * width + j] = oldWords[i]!.text === newWords[j]!.text
        ? lengths[(i + 1) * width + j + 1]! + weight
        : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < oldWords.length && j < newWords.length) {
    if (oldWords[i]!.text === newWords[j]!.text) {
      oldWords[i++]!.changed = false;
      newWords[j++]!.changed = false;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) i++;
    else j++;
  }
}

/** Keep source text literal, including whitespace and diff markers. */
export function parseDiff(patch: string, fragment = false): DiffLine[] {
  const source = patch.replace(/\n$/, "").split("\n");
  let oldRemaining = 0;
  let newRemaining = 0;
  const lines: DiffLine[] = source.map((text, index) => {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
    let kind: DiffLine["kind"] = "context";
    if (!fragment && hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      kind = "hunk";
    } else if (text.startsWith("\\ No newline at end of file")) kind = "meta";
    else if (!fragment && oldRemaining <= 0 && newRemaining <= 0 && (
      (text.startsWith("--- ") && source[index + 1]?.startsWith("+++ ")) ||
      (text.startsWith("+++ ") && source[index - 1]?.startsWith("--- ")) ||
      text.startsWith("diff ") || text.startsWith("index ")
    )) kind = "meta";
    else if (text.startsWith("+")) { kind = "add"; newRemaining--; }
    else if (text.startsWith("-")) { kind = "del"; oldRemaining--; }
    else if (text.startsWith(" ")) { oldRemaining--; newRemaining--; }
    return { kind, parts: [{ text, changed: false }] };
  });
  if (patch.length > DIFF_LIMITS.characters) return lines;

  let remainingCells: number = DIFF_LIMITS.matrixCells;
  for (let start = 0; start < lines.length;) {
    const removed: number[] = [];
    const added: number[] = [];
    let end = start;
    while (lines[end]?.kind === "del" || lines[end]?.kind === "add" || source[end]?.startsWith("\\ No newline at end of file")) {
      if (lines[end]!.kind === "del") removed.push(end);
      else if (lines[end]!.kind === "add") added.push(end);
      end++;
    }
    start = Math.max(start + 1, end);
    if (!removed.length || !added.length) continue;
    const body = (indexes: number[]) => indexes.map(index => lines[index]!.parts[0]!.text.slice(1)).join("\n");
    const oldWords = tokens(body(removed));
    const newWords = tokens(body(added));
    if (!oldWords || !newWords) continue;
    const cells = (oldWords.length + 1) * (newWords.length + 1);
    if (cells > remainingCells) continue;
    remainingCells -= cells;
    matchWords(oldWords, newWords);
    decorate(lines, removed, oldWords);
    decorate(lines, added, newWords);
  }
  return lines;
}
