import { describe, expect, it } from "vitest";
import { redactText, REDACTED } from "../src";

describe("redactText", () => {
  const cases: Array<[string, string]> = [
    ['curl -H "Authorization: Bearer abcdef1234567890" https://x', 'curl -H "Authorization: Bearer [REDACTED]" https://x'],
    ["export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 && ls", `export GITHUB_TOKEN=${REDACTED} && ls`],
    ["ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAA node x.js", `ANTHROPIC_API_KEY=${REDACTED} node x.js`],
    ["psql postgres://admin:hunter2@db.local/app", `psql postgres://admin:${REDACTED}@db.local/app`],
    ["deploy --token s3cr3t-value --env prod", `deploy --token ${REDACTED} --env prod`],
    ["aws s3 ls # AKIAABCDEFGHIJKLMNOP", `aws s3 ls # ${REDACTED}`],
    ["PASSWORD='my pass' ./run", `PASSWORD=${REDACTED} ./run`],
  ];
  for (const [input, expected] of cases) {
    it(`redacts: ${input.slice(0, 40)}`, () => {
      const r = redactText(input);
      expect(r.redacted).toBe(true);
      expect(r.text).toBe(expected);
    });
  }

  it("leaves ordinary commands alone", () => {
    const r = redactText("pnpm test --filter @agentwatch/daemon && git status --short");
    expect(r.redacted).toBe(false);
    expect(r.text).toBe("pnpm test --filter @agentwatch/daemon && git status --short");
  });

  it("removes PEM private keys", () => {
    const r = redactText("echo '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'");
    expect(r.text).not.toContain("MIIEow");
  });
});
