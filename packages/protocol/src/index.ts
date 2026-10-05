export * from "./events";
export * from "./privacy";
export * from "./redact";
export * from "./ws";

import { z } from "zod";

/**
 * zod 4 compiles validators with `new Function` unless told not to. The packaged app's CSP forbids
 * eval, so the UI calls this once at startup. Validation behaviour is identical.
 */
export function disableSchemaJit(): void {
  z.config({ jitless: true });
}
