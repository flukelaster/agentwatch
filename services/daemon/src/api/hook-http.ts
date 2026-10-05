import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isHookProvider, type HookProviderName } from "../hooks";

export const MAX_HOOK_BYTES = 2 * 1024 * 1024;

export interface HookHandlerDeps {
  secret: string;
  onHook: (provider: HookProviderName, payload: unknown, wrapperSessionId: string | undefined) => void;
  onReject?: (why: string, detail?: string) => void;
}

function authorized(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * POST /hook/<claude|codex|gemini|cursor> on the loopback server. Authenticated with a bearer secret that only the
 * hook script can read, so a web page cannot inject events (it cannot set the header without a CORS
 * preflight, and no CORS headers are ever sent). Answers immediately; mapping happens after the response.
 * Returns true when it handled the request.
 */
export function handleHookRequest(req: IncomingMessage, res: ServerResponse, deps: HookHandlerDeps): boolean {
  const m = /^\/hook\/([a-z]+)$/.exec(req.url ?? "");
  if (!m) return false;
  const reply = (code: number) => {
    res.writeHead(code, { "content-length": "0", connection: "close" }).end();
  };
  if (req.method !== "POST" || !isHookProvider(m[1]!)) {
    reply(404);
    return true;
  }
  if (!authorized(req.headers.authorization, deps.secret)) {
    deps.onReject?.("unauthorized");
    reply(401);
    req.destroy();
    return true;
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_HOOK_BYTES) {
    deps.onReject?.("too large", `${declared} bytes declared`);
    reply(413);
    req.destroy();
    return true;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_HOOK_BYTES) {
      aborted = true;
      deps.onReject?.("too large", `more than ${MAX_HOOK_BYTES} bytes`);
      reply(413);
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (err) {
      deps.onReject?.("bad json", `${Buffer.concat(chunks).length} bytes: ${err instanceof Error ? err.message : String(err)}`);
      reply(400);
      return;
    }
    reply(204);
    const raw = req.headers["x-agentwatch-session"];
    const session = typeof raw === "string" && /^[\w-]{1,200}$/.test(raw) ? raw : undefined;
    setImmediate(() => {
      try {
        deps.onHook(m[1] as HookProviderName, payload, session);
      } catch (err) {
        deps.onReject?.("mapping failed", err instanceof Error ? `${err.message} @ ${(err.stack ?? "").split("\n")[1]?.trim() ?? ""}` : String(err));
      }
    });
  });
  req.on("error", () => undefined);
  return true;
}
