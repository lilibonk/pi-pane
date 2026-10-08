import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const marked = new Marked({ gfm: true, breaks: false, async: false });
marked.use({
  renderer: {
    // Raw HTML in model output is shown as text, never parsed.
    html(token: Tokens.HTML | Tokens.Tag) { return escapeHtml(token.text); },
    // Remote images could track the reader; show them as links instead.
    image(token: Tokens.Image) {
      const label = escapeHtml(token.text || token.title || token.href);
      return `<a href="${escapeHtml(token.href)}">[图片：${label}]</a>`;
    },
  },
});

const purify = DOMPurify(window);
purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
  if (node.tagName === "INPUT") node.setAttribute("disabled", "");
});
const SANITIZE = {
  ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "s", "code", "pre", "blockquote", "ul", "ol", "li", "a",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td", "input", "span"],
  ALLOWED_ATTR: ["href", "title", "class", "checked", "disabled", "type", "align", "start"],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  ALLOW_DATA_ATTR: false,
};

/** Sanitized HTML for one Markdown text, cached by content. */
const cache = new Map<string, string>();
export function renderMarkdown(text: string): string {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const html = purify.sanitize(marked.parse(text) as string, SANITIZE) as string;
  // Streaming re-renders produce many prefixes; keep the cache small.
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  cache.set(text, html);
  return html;
}

/** Highlighter output is sanitized as well: only spans with inline colors survive. */
export function sanitizeHighlight(html: string): string {
  return purify.sanitize(html, { ALLOWED_TAGS: ["pre", "code", "span"], ALLOWED_ATTR: ["class", "style"] }) as string;
}
