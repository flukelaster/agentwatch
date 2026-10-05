import { loadConfig } from "./config";
import { startDaemon } from "./daemon";

const config = loadConfig();

// One bad observer call must not take down the service that every hook depends on: log it and keep serving.
// A genuine crash loop (many in a minute) still exits so the app's supervisor can see it.
const faults: number[] = [];
let log: (m: string) => void = (m) => process.stderr.write(`${new Date().toISOString()} WARN  ${m}\n`);
const survive = (kind: string) => (err: unknown) => {
  const now = Date.now();
  faults.push(now);
  while (faults.length && now - faults[0]! > 60_000) faults.shift();
  const e = err as NodeJS.ErrnoException;
  log(`${kind}: ${e?.code ?? ""} ${e?.syscall ?? ""} ${e instanceof Error ? e.message : String(err)}`.replace(/\s+/g, " ").trim());
  if (faults.length > 20) {
    log("too many faults in a minute: exiting");
    process.exit(1);
  }
};
process.on("uncaughtException", survive("uncaught exception"));
process.on("unhandledRejection", survive("unhandled rejection"));

startDaemon(config)
  .then((d) => {
    log = (m) => d.diagnostics.info("daemon", m);
    const shutdown = (sig: string) => {
      d.diagnostics.info("daemon", `${sig}: shutting down`);
      d.stop()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // `--parent <pid>`: exit when the process that started us is gone, so a crashed or force-quit app
    // can never leave an orphaned daemon behind.
    const i = process.argv.indexOf("--parent");
    const parent = i >= 0 ? Number(process.argv[i + 1]) : Number(process.env.AGENTWATCH_PARENT_PID ?? NaN);
    if (Number.isInteger(parent) && parent > 1) {
      const watch = setInterval(() => {
        try {
          process.kill(parent, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") shutdown("parent exited");
        }
      }, 5000);
      watch.unref();
    }
  })
  .catch((err: Error) => {
    process.stderr.write(`agentwatchd: ${err.message}\n`);
    process.exit(1);
  });
