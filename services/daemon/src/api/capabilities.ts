import { randomBytes } from "node:crypto";

/**
 * Short-lived, single-use capabilities for the UI's WebSocket. The Tauri backend (or the dev server)
 * mints one over the local socket and the UI presents it in its first frame. The long-lived secret
 * never goes into a URL.
 */
export class CapabilityStore {
  private readonly tokens = new Map<string, number>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  mint(): { token: string; expiresAt: string } {
    this.sweep();
    const token = randomBytes(32).toString("base64url");
    const exp = this.now() + this.ttlMs;
    this.tokens.set(token, exp);
    return { token, expiresAt: new Date(exp).toISOString() };
  }

  /** True once per valid, unexpired token. */
  consume(token: string): boolean {
    const exp = this.tokens.get(token);
    this.tokens.delete(token);
    return exp !== undefined && exp > this.now();
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, exp] of this.tokens) if (exp <= t) this.tokens.delete(k);
  }
  get size(): number {
    return this.tokens.size;
  }
}
