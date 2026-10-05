/**
 * Credential redaction. Applied to every command line, error string and log message
 * BEFORE anything is persisted or streamed, so a token in a command never reaches SQLite.
 * This is best-effort pattern matching, not a guarantee; the privacy model also avoids
 * collecting the data in the first place.
 */

export const REDACTED = "[REDACTED]";

interface Rule {
  name: string;
  pattern: RegExp;
  replace: string | ((substring: string, ...groups: string[]) => string);
}

const RULES: Rule[] = [
  // PEM private keys
  {
    name: "pem",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: REDACTED,
  },
  // Authorization: Bearer xxx / Basic xxx (header text or curl -H)
  {
    name: "auth-header",
    pattern: /(authorization\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{6,}/gi,
    replace: (_m, p1) => `${p1}${REDACTED}`,
  },
  {
    name: "bearer",
    pattern: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_m, p1) => `${p1}${REDACTED}`,
  },
  // Well-known token shapes
  { name: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replace: REDACTED },
  { name: "openai", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { name: "github", pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { name: "aws-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: REDACTED },
  { name: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { name: "google", pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: REDACTED },
  { name: "npm", pattern: /\bnpm_[A-Za-z0-9]{30,}/g, replace: REDACTED },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // Credentials embedded in URLs: scheme://user:pass@host
  {
    name: "url-userinfo",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    replace: (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`,
  },
  // KEY=value style assignments for secret-looking names (env prefixes, flags)
  {
    name: "assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"';&|]+)/gi,
    replace: (m, name, sep, value) =>
      /^(?:bearer|basic|token|\[redacted\])$/i.test(value ?? "") ? m : `${name}${sep}${REDACTED}`,
  },
  // --password foo / --token foo / -p foo style flags
  {
    name: "flag",
    pattern: /(--(?:password|passwd|token|secret|api-key|apikey|auth|access-token|client-secret)(?:\s+|=))("[^"]*"|'[^']*'|[^\s"';&|]+)/gi,
    replace: (_m, flag) => `${flag}${REDACTED}`,
  },
  // mysql -pSECRET (no space) is too ambiguous; handled by the assignment/flag rules above.
];

export interface RedactionResult {
  text: string;
  redacted: boolean;
}

export function redactText(input: string): RedactionResult {
  let text = input;
  let redacted = false;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const next = text.replace(rule.pattern, rule.replace as never);
    if (next !== text) {
      redacted = true;
      text = next;
    }
  }
  return { text, redacted };
}
