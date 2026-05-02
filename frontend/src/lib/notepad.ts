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
