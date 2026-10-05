import { createConnection } from "node:net";

export interface IpcOptions {
  socket: string;
  timeoutMs?: number;
}

/**
 * Sends newline-delimited JSON frames to the daemon and collects one reply per frame.
 * Resolves with whatever arrived; never throws. A missing daemon must not break the agent.
 */
export function sendFrames(frames: unknown[], opts: IpcOptions): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const replies: Array<Record<string, unknown>> = [];
    if (frames.length === 0) return resolve(replies);
    let buf = "";
    let settled = false;
    const sock = createConnection(opts.socket);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(replies);
    };
    const timer = setTimeout(finish, opts.timeoutMs ?? 800);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n"));
    sock.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          replies.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* ignore malformed reply */
        }
        if (replies.length >= frames.length) return finish();
      }
    });
    sock.on("error", finish);
    sock.on("close", finish);
  });
}

export async function sendEvents(events: unknown[], opts: IpcOptions): Promise<number> {
  const replies = await sendFrames(events.map((event) => ({ op: "event", event })), opts);
  return replies.filter((r) => r.ok === true).length;
}
