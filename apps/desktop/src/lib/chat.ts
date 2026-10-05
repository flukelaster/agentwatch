import type { AgentEvent } from "@agentwatch/protocol";

export interface ChatPolicy {
  prompts: boolean;
  responses: boolean;
}

export interface ChatMessage {
  id: string;
  seq: number;
  role: "user" | "assistant";
  body: string;
  at: string;
}

/** The messages of one session in the order they happened, limited to the kinds the person has turned on. */
export function chatMessages(events: readonly AgentEvent[], policy: ChatPolicy): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of events) {
    if (e.kind !== "message") continue;
    const role = e.payload.role;
    const body = e.payload.body;
    if ((role !== "user" && role !== "assistant") || typeof body !== "string" || !body) continue;
    if ((role === "user" && !policy.prompts) || (role === "assistant" && !policy.responses)) continue; // switched off: hide what may still be in the buffer
    out.push({ id: e.id, seq: e.sequence, role, body, at: e.occurredAt });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
}

export type Inline = { t: "text" | "code" | "bold"; text: string };
export type Block = { t: "p"; inline: Inline[] } | { t: "code"; lang: string; text: string } | { t: "list"; ordered: boolean; items: Inline[][] } | { t: "heading"; inline: Inline[] };

/** `code` and **bold** inside one line. Everything else stays literal text: nothing is ever interpreted as markup. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ t: "text", text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { t: "code", text: m[1] } : { t: "bold", text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** A small, safe reader for what an assistant writes: paragraphs, lists, headings and fenced code. */
export function parseBlocks(body: string): Block[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", inline: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i += 1; i < lines.length && !/^\s*```\s*$/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ t: "code", lang: fence[1] ?? "", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^#{1,4}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ t: "heading", inline: parseInline(heading[1]!) });
      continue;
    }
    if (BULLET.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items: Inline[][] = [];
      for (; i < lines.length && BULLET.test(lines[i]!); i++) items.push(parseInline(lines[i]!.replace(BULLET, "")));
      i -= 1;
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}
