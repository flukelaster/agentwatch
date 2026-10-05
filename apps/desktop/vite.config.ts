import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev only. In the packaged app the Tauri backend mints the UI's capability. In the browser dev
 * server this tiny endpoint does the same over the daemon's local socket (same user, same machine).
 * It is not part of the production build, and it only answers loopback requests.
 */
function devCapability(): Plugin {
  const socket = join(process.env.AGENTWATCH_HOME ?? join(homedir(), "Library", "Application Support", "AgentWatch"), "agentwatchd.sock");
  return {
    name: "agentwatch-dev-capability",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__aw/mint", (req, res) => {
        const remote = req.socket.remoteAddress ?? "";
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
          res.statusCode = 403;
          return res.end();
        }
        const sock = createConnection(socket);
        let buf = "";
        const fail = () => {
          if (!res.writableEnded) {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "agentwatchd is not running" }));
          }
        };
        sock.setEncoding("utf8");
        sock.setTimeout(1500, () => {
          sock.destroy();
          fail();
        });
        sock.on("error", fail);
        sock.on("connect", () => sock.write(JSON.stringify({ op: "mint" }) + "\n"));
        sock.on("data", (d: string) => {
          buf += d;
          if (buf.includes("\n")) {
            sock.end();
            res.setHeader("content-type", "application/json");
            res.setHeader("cache-control", "no-store");
            res.end(buf.split("\n")[0]);
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devCapability()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { target: "safari15", sourcemap: false },
  test: { environment: "jsdom", globals: false, css: false, setupFiles: ["./test/setup.ts"] },
});
