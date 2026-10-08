import { useEffect, useRef, useState } from "preact/hooks";
import type { ContentView, MessageView, ToolView } from "../protocol/index.js";
import { highlight, languageForPath } from "./highlight.js";
import { renderMarkdown } from "./markdown.js";
import { collapseContent, expandContent, type Expansion } from "./store.js";

export type Expansions = Record<string, Expansion>;
type ToolCall = Extract<ContentView, { type: "toolCall" }>;
type TextBlock = Exclude<ContentView, ToolCall>;

export const COMPACTION_MARKER = "[Context compacted]";

function argsOf(call: ToolCall | undefined): Record<string, unknown> {
  const value = call?.arguments;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
/** An expansion is current only while the block still has the length it was read at. */
function currentExpansion(message: MessageView, index: number, expansions: Expansions): Expansion | undefined {
  const block = message.content[index] as TextBlock;
  const expanded = expansions[`${message.id}#${index}`];
  return expanded && !expanded.loading && !expanded.error && expanded.total === block.total ? expanded : undefined;
}
function blockText(message: MessageView, index: number, expansions: Expansions): string {
  return currentExpansion(message, index, expansions)?.text ?? (message.content[index] as TextBlock).text;
}

/** Shows how much of a clipped block is present and lets the reader load the rest. */
function Clipped({ message, index, expansions }: { message: MessageView; index: number; expansions: Expansions }) {
  const block = message.content[index] as TextBlock;
  if (block.total === undefined) return null;
  const expansion = expansions[`${message.id}#${index}`];
  const stale = !!expansion && !expansion.loading && !expansion.error && expansion.total !== block.total;
  if (currentExpansion(message, index, expansions) && expansion) {
    return (
      <p class="truncation">
        {expansion.capped ? `已加载前 ${expansion.text.length.toLocaleString()} / ${expansion.total.toLocaleString()} 字符（浏览器上限）。` : `已加载全部 ${expansion.total.toLocaleString()} 字符。`}
        <button type="button" class="link-button" onClick={() => collapseContent(message, index)}>收起</button>
      </p>
    );
  }
  return (
    <p class="truncation">
      显示前 {block.text.length.toLocaleString()} / {block.total.toLocaleString()} 字符。
      <button type="button" class="link-button" disabled={expansion?.loading} onClick={() => expandContent(message, index)}>
        {expansion?.loading ? `加载中 ${expansion.text.length.toLocaleString()}…` : stale ? "内容已更新，重新加载" : "加载全部"}
      </button>
      {expansion?.error && <span class="error-text">{expansion.error}</span>}
    </p>
  );
}

function Markdown({ text, final }: { text: string; final: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);
  useEffect(() => {
    // Highlight fenced code once the text is final; streaming text stays plain.
    if (!final || !ref.current) return;
    let cancelled = false;
    for (const code of ref.current.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
      const lang = /language-([\w+#-]+)/.exec(code.className)?.[1];
      const source = code.textContent ?? "";
      void highlight(source, lang).then((highlighted) => {
        const pre = code.parentElement;
        if (cancelled || !highlighted || !pre?.isConnected || code.textContent !== source) return;
        pre.outerHTML = highlighted;
      });
    }
    return () => { cancelled = true; };
  }, [html, final]);
  return <div ref={ref} class="message-text markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Code({ code, lang, class: className = "" }: { code: string; lang?: string; class?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    if (lang) void highlight(code, lang).then((value) => { if (!cancelled) setHtml(value); });
    return () => { cancelled = true; };
  }, [code, lang]);
  return html
    ? <div class={`code-block ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
    : <pre class={`code-block ${className}`}>{code}</pre>;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-context";
}
export function Diff({ patch }: { patch: string }) {
  const lines = patch.replace(/\n$/, "").split("\n");
  return <pre class="diff">{lines.map((line, index) => <div class={lineClass(line)} key={index}>{line || " "}</div>)}</pre>;
}

function resultText(result: MessageView | undefined, expansions: Expansions): string | undefined {
  if (!result) return undefined;
  const parts = result.content.flatMap((block, index) => block.type === "text" ? [blockText(result, index, expansions)] : []);
  return parts.length ? parts.join("\n") : undefined;
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  const path = str(args.path);
  switch (name) {
    case "bash": return `$ ${str(args.command) ?? ""}`;
    case "read": {
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      return `read ${path ?? ""}${offset !== undefined ? `:${offset}${limit !== undefined ? `+${limit}` : ""}` : ""}`;
    }
    case "write": return `write ${path ?? ""}`;
    case "edit": return `edit ${path ?? ""}${Array.isArray(args.edits) ? ` · ${args.edits.length} 处` : ""}`;
    case "grep": return `grep ${str(args.pattern) ?? ""}${path ? ` · ${path}` : ""}`;
    case "find": return `find ${str(args.pattern) ?? ""}${path ? ` · ${path}` : ""}`;
    case "ls": return `ls ${path ?? "."}`;
    default: return name;
  }
}

function argsJson(call: ToolCall | undefined, live: ToolView | undefined): string {
  const value = call?.arguments ?? live?.args;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? null, null, 2); } catch { return ""; }
}

/** One tool call: its arguments, live output while running, and the final result. */
export function ToolCard({ call, result, live, expansions }: { call?: ToolCall; result?: MessageView; live?: ToolView; expansions: Expansions }) {
  const name = call?.name ?? result?.toolName ?? live?.name ?? "tool";
  const args = Object.keys(argsOf(call)).length ? argsOf(call) : (live?.args && typeof live.args === "object" ? live.args as Record<string, unknown> : {});
  const status = result ? (result.isError ? "error" : "complete") : live?.status ?? "pending";
  const output = resultText(result, expansions) ?? live?.output;
  const diffIndex = result?.content.findIndex((block) => block.type === "diff") ?? -1;
  const diff = diffIndex >= 0 ? blockText(result!, diffIndex, expansions) : undefined;
  const path = str(args.path);
  const builtin = ["bash", "read", "write", "edit", "grep", "find", "ls"].includes(name);
  const open = status === "running" || status === "error" || (name === "edit" && !!diff);
  const textIndexes = result ? result.content.flatMap((block, index) => block.type === "text" && block.total !== undefined ? [index] : []) : [];
  return (
    <details class={`tool-card tool-${status} tool-name-${builtin ? name : "custom"} ${live?.parentToolCallId ? "tool-nested" : ""}`} open={open} data-tool-id={call?.id ?? result?.toolCallId ?? live?.id}>
      <summary>
        <span class="tool-title"><span class="tool-symbol">{name === "bash" ? "❯" : "⌘"}</span><span class="mono tool-summary">{toolTitle(name, args)}</span></span>
        <span class="tool-status">{status === "running" ? "执行中" : status === "error" ? "执行失败" : status === "pending" ? "等待执行" : "已完成"}</span>
      </summary>
      <div class="tool-body">
        {live?.parentToolCallId && <p class="subtle">嵌套调用 · {live.parentToolCallId}</p>}
        {!builtin && <><div class="tool-label">参数{call?.argsTruncated ? " · 已截断" : ""}</div><pre>{argsJson(call, live)}</pre></>}
        {name === "write" && str(args.content) !== undefined && <Code code={str(args.content)!} lang={languageForPath(path)} />}
        {name === "edit" && diff !== undefined && <Diff patch={diff} />}
        {name === "edit" && diff === undefined && Array.isArray(args.edits) && (args.edits as Array<Record<string, unknown>>).map((edit, index) => (
          <Diff key={index} patch={[...String(edit.oldText ?? "").split("\n").map((line) => `-${line}`), ...String(edit.newText ?? "").split("\n").map((line) => `+${line}`)].join("\n")} />
        ))}
        {output !== undefined && name !== "edit" && (
          <>
            <div class="tool-label">{status === "running" ? "当前输出" : "结果"}{!result && live?.outputTotal ? ` · 仅显示末尾，共 ${live.outputTotal.toLocaleString()} 字符` : ""}</div>
            {name === "read" && status === "complete" ? <Code code={output} lang={languageForPath(path)} /> : <pre class={`tool-output ${status === "error" ? "error-text" : ""}`}>{output}</pre>}
          </>
        )}
        {name === "edit" && status === "error" && output && <pre class="tool-output error-text">{output}</pre>}
        {result && textIndexes.map((index) => <Clipped key={index} message={result} index={index} expansions={expansions} />)}
        {result && diffIndex >= 0 && <Clipped message={result} index={diffIndex} expansions={expansions} />}
      </div>
    </details>
  );
}

export interface ToolContext {
  results: Map<string, MessageView>;
  live: Map<string, ToolView>;
}

export function Message({ message, tools, expansions }: { message: MessageView; tools: ToolContext; expansions: Expansions }) {
  const final = message.status === "complete";
  if (message.role === "system" && message.content.length === 1 && message.content[0]!.type === "text" && message.content[0]!.text === COMPACTION_MARKER)
    return <div class="compaction-marker" data-message-id={message.id}><span>上下文已压缩</span></div>;
  if (message.role === "toolResult")
    return <div class="message message-toolResult" data-message-id={message.id}><ToolCard result={message} live={message.toolCallId ? tools.live.get(message.toolCallId) : undefined} expansions={expansions} /></div>;
  const role = message.role === "user" ? "你" : message.role === "assistant" ? "pi" : message.role === "bashExecution" ? "终端命令" : message.role;
  const plain = message.role !== "assistant";
  return (
    <article class={`message message-${message.role} ${message.isError ? "message-error" : ""}`} data-message-id={message.id}>
      <div class="message-meta"><span class="role">{role}</span>{message.status === "streaming" && <span class="streaming">正在生成</span>}</div>
      <div class="message-body">
        {message.content.map((content, index) => {
          if (content.type === "toolCall")
            return <ToolCard key={index} call={content} result={tools.results.get(content.id)} live={tools.live.get(content.id)} expansions={expansions} />;
          const text = blockText(message, index, expansions);
          if (!text && content.total === undefined) return null;
          if (content.type === "thinking") return (
            <details class="thinking" key={index}>
              <summary>思考过程{message.status === "streaming" ? " · 生成中" : ""}</summary>
              <pre>{text}</pre>
              <Clipped message={message} index={index} expansions={expansions} />
            </details>
          );
          if (content.type === "diff") return <div key={index}><Diff patch={text} /><Clipped message={message} index={index} expansions={expansions} /></div>;
          return (
            <div key={index}>
              {plain ? <pre class="message-text">{text}</pre> : <Markdown text={text} final={final} />}
              <Clipped message={message} index={index} expansions={expansions} />
            </div>
          );
        })}
        {!message.content.length && <span class="empty-content">等待内容…</span>}
        {message.truncated && <p class="truncation">部分内容块未在网页中显示，请查看终端。</p>}
      </div>
    </article>
  );
}
