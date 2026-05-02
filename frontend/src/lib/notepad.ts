/**
 * Shared notepad helpers (issue #98).
 *
 * Path C of the approved plan: server runs pycrdt purely as a CRDT
 * relay; markdown extraction + the AAR's source of truth happens on
 * the client. This module owns:
 *
 *   1. The TipTap editor → markdown serializer (a small JSON-tree
 *      walker — enough to cover the editor's shipped node set, not a
 *      full prosemirror-markdown bridge).
 *   2. The HTTP wrappers for /notepad/{snapshot,pin,template,templates,export.md}.
 */
import type { Editor } from "@tiptap/core";

export interface NotepadTemplate {
  id: string;
  label: string;
  description: string;
  content: string;
}

interface ListTemplatesResponse {
  templates: NotepadTemplate[];
}

function scrubToken(path: string): string {
  return path.replace(/([?&]token=)[^&]+/gi, "$1***");
}

async function notepadFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const safe = scrubToken(path);
  const start = performance.now();
  const res = await fetch(path, init);
  const ms = Math.round(performance.now() - start);
  const tag = `[notepad] ${init.method ?? "GET"} ${safe} → ${res.status} (${ms}ms)`;
  if (!res.ok) {
    console.warn(tag);
    let detail = `${res.status}`;
    try {
      const json = (await res.clone().json()) as { detail?: string };
      detail = json.detail ?? detail;
    } catch {
      /* response wasn't JSON; keep status */
    }
    throw new Error(detail);
  }
  console.debug(tag);
  return res;
}

export async function listTemplates(
  sessionId: string,
  token: string,
): Promise<NotepadTemplate[]> {
  const res = await notepadFetch(
    `/api/sessions/${sessionId}/notepad/templates?token=${encodeURIComponent(token)}`,
    { method: "GET" },
  );
  const body = (await res.json()) as ListTemplatesResponse;
  return body.templates;
}

export async function applyTemplate(
  sessionId: string,
  token: string,
  templateId: string,
): Promise<void> {
  await notepadFetch(
    `/api/sessions/${sessionId}/notepad/template?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_id: templateId }),
    },
  );
}

export async function pushSnapshot(
  sessionId: string,
  token: string,
  markdown: string,
): Promise<void> {
  await notepadFetch(
    `/api/sessions/${sessionId}/notepad/snapshot?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown }),
    },
  );
}

export async function pinToNotepad(
  sessionId: string,
  token: string,
  text: string,
  sourceMessageId: string | null,
): Promise<void> {
  await notepadFetch(
    `/api/sessions/${sessionId}/notepad/pin?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source_message_id: sourceMessageId }),
    },
  );
}

export function exportMarkdownUrl(sessionId: string, token: string): string {
  return `/api/sessions/${sessionId}/notepad/export.md?token=${encodeURIComponent(token)}`;
}

/**
 * Convert the limited markdown subset our starter templates use
 * (``## headings``, ``- bullets``, ``- [ ]`` task items, blank-line
 * paragraphs, ``_italic_``, inline ``\`code\```) into HTML that
 * TipTap can parse via ``insertContent(html, { parseOptions })``.
 *
 * NOT a general markdown parser — extending the templates with new
 * constructs means extending this. For anything richer we'd reach for
 * `marked` or similar; today's templates don't pay for that dep.
 *
 * Lives in lib/ rather than the SharedNotepad component file so the
 * react-refresh fast-refresh check stays happy (component files
 * should only export components).
 */
export function templateMarkdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let listKind: "ul" | "tasklist" | null = null;

  function closeList(): void {
    if (listKind === "ul") out.push("</ul>");
    else if (listKind === "tasklist") out.push("</ul>");
    listKind = null;
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inlineFormat(s: string): string {
    let r = escapeHtml(s);
    // Inline code first (no other inline format applies inside backticks).
    r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Bold then italic so ``**word**`` doesn't get caught by ``_word_``.
    r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/(^|\W)_([^_]+)_(\W|$)/g, "$1<em>$2</em>$3");
    return r;
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
      continue;
    }
    const task = /^[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (task) {
      if (listKind !== "tasklist") {
        closeList();
        out.push('<ul data-type="taskList">');
        listKind = "tasklist";
      }
      const checked = task[1].toLowerCase() === "x";
      out.push(
        `<li data-type="taskItem" data-checked="${checked}"><p>${inlineFormat(
          task[2],
        )}</p></li>`,
      );
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      if (listKind !== "ul") {
        closeList();
        out.push("<ul>");
        listKind = "ul";
      }
      out.push(`<li><p>${inlineFormat(bullet[1])}</p></li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineFormat(line)}</p>`);
  }
  closeList();
  return out.join("");
}

/**
 * Walk a ProseMirror/TipTap JSON document and emit markdown.
 *
 * This intentionally covers only the node set the editor exposes
 * (StarterKit + the task-list extensions). It is NOT a general
 * prosemirror-markdown serializer; it's the simplest thing that
 * round-trips what users can actually type. If you add a new TipTap
 * extension that introduces a new node, you also extend this walker.
 */
export function editorToMarkdown(editor: Editor): string {
  return docToMarkdown(editor.getJSON()).trim() + "\n";
}

interface PMNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function docToMarkdown(node: PMNode): string {
  return (node.content ?? []).map((child) => renderBlock(child)).join("\n\n");
}

function renderBlock(node: PMNode): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${"#".repeat(level)} ${renderInline(node)}`;
    }
    case "bulletList":
      return renderList(node, "bullet");
    case "orderedList":
      return renderList(node, "ordered");
    case "taskList":
      return renderList(node, "task");
    case "listItem":
    case "taskItem":
      // Should be reached via renderList; bare list-items render as plain.
      return renderListItem(node, 0, "bullet");
    case "blockquote":
      return (node.content ?? [])
        .map((c) => "> " + renderBlock(c))
        .join("\n");
    case "codeBlock": {
      const code = (node.content ?? [])
        .map((c) => c.text ?? "")
        .join("");
      return "```" + (node.attrs?.language ?? "") + "\n" + code + "\n```";
    }
    case "horizontalRule":
      return "---";
    default:
      return renderInline(node);
  }
}

function renderList(
  node: PMNode,
  kind: "bullet" | "ordered" | "task",
): string {
  const items = node.content ?? [];
  return items
    .map((item, idx) => renderListItem(item, idx, kind))
    .join("\n");
}

function renderListItem(
  node: PMNode,
  index: number,
  kind: "bullet" | "ordered" | "task",
): string {
  let prefix: string;
  if (kind === "ordered") {
    prefix = `${index + 1}. `;
  } else if (kind === "task" || node.type === "taskItem") {
    const checked = Boolean(node.attrs?.checked);
    prefix = `- [${checked ? "x" : " "}] `;
  } else {
    prefix = "- ";
  }
  // Each list-item wraps a paragraph (or more); flatten and join with \n
  // (no double-blank between list items).
  const inner = (node.content ?? [])
    .map((c) => renderBlock(c).replace(/\n/g, "\n  "))
    .join("\n  ");
  return prefix + inner;
}

function renderInline(node: PMNode): string {
  return (node.content ?? [])
    .map((c) => {
      if (c.type === "text") {
        return wrapMarks(c.text ?? "", c.marks ?? []);
      }
      if (c.type === "hardBreak") return "  \n";
      return renderInline(c);
    })
    .join("");
}

function wrapMarks(
  text: string,
  marks: { type: string; attrs?: Record<string, unknown> }[],
): string {
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        out = `**${out}**`;
        break;
      case "italic":
        out = `*${out}*`;
        break;
      case "code":
        out = "`" + out + "`";
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "link": {
        const href = String(mark.attrs?.href ?? "");
        out = `[${out}](${href})`;
        break;
      }
      default:
        break;
    }
  }
  return out;
}
