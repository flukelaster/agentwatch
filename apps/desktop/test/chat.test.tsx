import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGraph, promptInfoFor } from "../src/components/AgentGraph";
import { ChatPanel } from "../src/components/ChatPanel";
import { Conf, DiffStat, EmptyState } from "../src/components/ui";
import { ContextMeter, OPEN_CONTEXT_EVENT, contextLevel } from "../src/components/ContextMeter";
import { ContextPanel } from "../src/components/ContextPanel";
import { GRID_CELLS, allocateCells, contextParts } from "../src/lib/contextGrid";
import { ProviderIcon, UiIcon } from "../src/components/icons";
import { chatMessages, parseBlocks, parseInline, type ChatMessage } from "../src/lib/chat";
import { DaemonProvider } from "../src/lib/context";
import { layoutGraph } from "../src/lib/graph";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { event, mainAgent, resetSeq, session } from "./fixtures";

beforeEach(resetSeq);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const msg = (id: string, role: "user" | "assistant", body: string, at = "2026-01-01T00:00:00.000Z"): ChatMessage => ({ id, seq: 1, role, body, at });
const ON = { prompts: true, responses: true };

describe("chatMessages", () => {
  const ev = (role: string, body: string, at: string) => event({ kind: "message", source: "transcript", payload: { role, body }, occurredAt: at });
  it("keeps the order things were said in and hides a kind that is switched off", () => {
    const events = [ev("assistant", "second", "2026-01-01T00:00:02Z"), ev("user", "first", "2026-01-01T00:00:01Z"), event({ kind: "tool.started" })];
    expect(chatMessages(events, ON).map((m) => m.body)).toEqual(["first", "second"]);
    expect(chatMessages(events, { prompts: false, responses: true }).map((m) => m.body)).toEqual(["second"]);
    expect(chatMessages(events, { prompts: false, responses: false })).toEqual([]);
  });
  it("ignores malformed messages", () => {
    expect(chatMessages([event({ kind: "message", payload: { role: "system", body: "x" } }), event({ kind: "message", payload: { role: "user" } })], ON)).toEqual([]);
  });
});

describe("reading what an assistant writes", () => {
  it("splits paragraphs, lists, headings and fenced code", () => {
    const blocks = parseBlocks("# Plan\n\nFirst `thing` and **bold**.\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\nAfter");
    expect(blocks.map((b) => b.t)).toEqual(["heading", "p", "list", "list", "code", "p"]);
    expect(blocks[1]).toMatchObject({ t: "p", inline: [{ t: "text", text: "First " }, { t: "code", text: "thing" }, { t: "text", text: " and " }, { t: "bold", text: "bold" }, { t: "text", text: "." }] });
    expect(blocks[3]).toMatchObject({ t: "list", ordered: true });
    expect(blocks[4]).toEqual({ t: "code", lang: "ts", text: "const x = 1;\n\nconst y = 2;" });
  });
  it("never turns text into markup", () => {
    const { container } = render(<ChatPanel session={session()} policy={ON} messages={[msg("a", "assistant", "<img src=x onerror=alert(1)> and <script>bad()</script>")]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>bad()</script>");
  });
  it("copes with an unterminated code fence", () => {
    expect(parseBlocks("```js\nlet a")).toEqual([{ t: "code", lang: "js", text: "let a" }]);
    expect(parseInline("a `unclosed")).toEqual([{ t: "text", text: "a `unclosed" }]);
  });
});

describe("ChatPanel", () => {
  it("says it is off, and where to turn it on, while both settings are off", () => {
    render(<ChatPanel session={session()} policy={{ prompts: false, responses: false }} messages={[]} />);
    expect(screen.getByText("Chat is off")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Settings" }).getAttribute("href")).toBe("#/settings");
  });
  it("explains an empty chat, and which half is switched off", () => {
    const { rerender } = render(<ChatPanel session={session()} policy={ON} messages={[]} />);
    expect(screen.getByText("No messages yet")).toBeTruthy();
    rerender(<ChatPanel session={session()} policy={{ prompts: true, responses: false }} messages={[]} />);
    expect(screen.getByText(/Assistant responses are off in Settings/)).toBeTruthy();
    rerender(<ChatPanel session={session({ provider: "codex" })} policy={ON} messages={[]} />);
    expect(screen.getByText("Chat is not available for this session")).toBeTruthy();
  });
  it("shows you and the assistant as a conversation, in order", () => {
    render(<ChatPanel session={session()} policy={ON} messages={[msg("u", "user", "Why does login fail?"), msg("a", "assistant", "The token expires early.\n\n```ts\nrefresh();\n```")]} />);
    const log = screen.getByRole("log");
    const roles = [...log.querySelectorAll("[data-role]")].map((n) => n.getAttribute("data-role"));
    expect(roles).toEqual(["user", "assistant"]);
    expect(screen.getByText("You")).toBeTruthy();
    expect(log.querySelector("pre code")!.textContent).toBe("refresh();");
  });
  it("notes when only one half of the conversation is being kept", () => {
    render(<ChatPanel session={session()} policy={{ prompts: true, responses: false }} messages={[msg("u", "user", "hello")]} />);
    expect(screen.getByText(/only your prompts are shown/)).toBeTruthy();
  });
  it("shows a working indicator while the agent is busy answering the last prompt", () => {
    const { rerender } = render(<ChatPanel session={session({ status: "running" })} policy={ON} messages={[msg("u", "user", "do it")]} />);
    expect(screen.getByLabelText(/is working/)).toBeTruthy();
    rerender(<ChatPanel session={session({ status: "idle" })} policy={ON} messages={[msg("u", "user", "do it")]} />);
    expect(screen.queryByLabelText(/is working/)).toBeNull();
  });
  it("writes a reply that arrives while you watch, instead of dropping it in at once; what was already there is not animated", () => {
    vi.useFakeTimers();
    const old = [msg("u", "user", "q"), msg("a1", "assistant", "an old reply that was already there")];
    const { rerender } = render(<ChatPanel session={session()} policy={ON} messages={old} />);
    expect(screen.getByText("an old reply that was already there")).toBeTruthy();
    const text = "A new reply. ".repeat(20).trim();
    rerender(<ChatPanel session={session()} policy={ON} messages={[...old, msg("a2", "assistant", text)]} />);
    expect(document.body.textContent).not.toContain(text); // not yet
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(document.body.textContent).toContain(text);
  });
});

describe("the chat under the graph", () => {
  function mount(search = "") {
    window.history.replaceState({}, "", `/${search}`);
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    const s = session();
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <AgentGraph session={s} agents={[mainAgent()]} events={[]} />
      </DaemonProvider>,
    );
    window.history.replaceState({}, "", "/");
  }
  it("starts on the Context tab, which is the first of three, with the chat and the details a tab away", () => {
    mount();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Context", "Chat", "Details"]);
    expect(screen.getByRole("tab", { name: "Context" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("The context window has not been read yet")).toBeTruthy(); // nothing read for this session yet
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByText("Chat is off")).toBeTruthy(); // the settings are off by default
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByRole("region", { name: "Details: main" })).toBeTruthy();
  });
  it("goes back to the Context tab when another session is chosen", () => {
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    const a = session({ id: "s1" });
    const b = session({ id: "s2" });
    const { rerender } = render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <AgentGraph session={a} agents={[mainAgent("s1")]} events={[]} />
      </DaemonProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    rerender(
      <DaemonProvider daemon={{ store, client: mock }}>
        <AgentGraph session={b} agents={[mainAgent("s2")]} events={[]} />
      </DaemonProvider>,
    );
    expect(screen.getByRole("tab", { name: "Context" }).getAttribute("aria-selected")).toBe("true");
  });
  it("opens the details when a node is chosen", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Inspect main" }));
    expect(screen.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("the prompt box", () => {
  const s = session();
  it("shows the latest prompt only while prompt text is stored, and says why there is none otherwise", () => {
    const on = promptInfoFor(s, [msg("1", "user", "first"), msg("2", "assistant", "reply"), msg("3", "user", "Fix the   login\nredirect")], { prompts: true })!;
    expect(on.userText).toBe("Fix the login redirect");
    expect(on.userNote).toMatch(/^2 prompts · last /);
    expect(on.systemText).toBe("Claude Code · built in · claude-sonnet-5-5");
    const off = promptInfoFor(s, [msg("3", "user", "secret text")], { prompts: false })!;
    expect(off.userText).toBeUndefined();
    expect(JSON.stringify(off)).not.toContain("secret text");
    expect(off.userNote).toMatch(/not stored/);
    expect(promptInfoFor(s, [], { prompts: true })!.userNote).toBe("No prompt read yet");
    expect(promptInfoFor(session({ provider: "generic" }), [], { prompts: true })).toBeUndefined();
  });
  it("is the first box of the graph, feeds main, and leaves room for the evidence sources", () => {
    const info = promptInfoFor(s, [], { prompts: true });
    const g = layoutGraph(session({ sources: ["claude-hook", "git"] }), [mainAgent()], { "claude-hook": 1, git: 1 }, undefined, info);
    const p = g.nodes.find((n) => n.kind === "prompt")!;
    expect([p.x, p.y]).toEqual([0, 12]);
    for (const n of g.nodes.filter((x) => x.kind === "source")) expect(n.y).toBeGreaterThanOrEqual(p.y + p.h);
    const edge = g.edges.find((e) => e.key === "prompt")!;
    expect(edge.to).toBe("main");
    expect(edge.dashed).toBe(false);
    expect(layoutGraph(session(), [mainAgent()], {}).nodes.some((n) => n.kind === "prompt")).toBe(false); // none unless asked for
  });
});

describe("icons and empty states", () => {
  it("uses the TheSVG marks for Claude Code and Codex, and a terminal for anything else", () => {
    const { container } = render(
      <>
        <ProviderIcon provider="claude-code" />
        <ProviderIcon provider="codex" />
        <ProviderIcon provider="generic" />
      </>,
    );
    expect([...container.querySelectorAll("svg")].map((n) => n.getAttribute("data-icon-source"))).toEqual(["thesvg:claude-code", "thesvg:codex-openai", "lucide:terminal"]);
    expect(container.querySelector('[data-icon-source="thesvg:claude-code"] path')!.getAttribute("fill")).toBe("#D97757"); // the brand colour is kept
  });
  it("renders an empty state with its icon, title, hint and a link", () => {
    render(<EmptyState icon="inbox" title="Nothing here" hint="Do the thing." action={{ label: "Go", href: "#/settings" }} />);
    expect(screen.getByRole("status").textContent).toContain("Nothing here");
    expect(screen.getByText("Do the thing.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go" }).getAttribute("href")).toBe("#/settings");
    cleanup();
    const { container } = render(<UiIcon name="search" />);
    expect(container.querySelector("svg")!.getAttribute("data-icon-source")).toBe("lucide:search");
  });
});

describe("severity colours and the diff", () => {
  it("marks confidence by severity: high green, medium amber, low red", () => {
    const { container } = render(
      <>
        <Conf level="high" />
        <Conf level="medium" />
        <Conf level="low" />
      </>,
    );
    const levels = [...container.querySelectorAll(".conf")].map((n) => n.className);
    expect(levels).toEqual(["conf conf--high", "conf conf--medium", "conf conf--low"]);
    expect([...container.querySelectorAll(".conf--high .conf__bars i.on")]).toHaveLength(3);
    expect([...container.querySelectorAll(".conf--low .conf__bars i.on")]).toHaveLength(1);
  });

  it("shows additions and deletions as separate green and red parts, and a dash for no change", () => {
    const { container, rerender } = render(<DiffStat diff={{ additions: 210, deletions: 0 }} />);
    expect(container.querySelector(".diff__add")!.textContent).toBe("+210");
    expect(container.querySelector(".diff__del")!.textContent).toBe("−0");
    expect(container.querySelector(".diff")!.textContent).toBe("+210 −0");
    rerender(<DiffStat diff={{ additions: 0, deletions: 0 }} />);
    expect(container.textContent).toBe("—");
    expect(container.querySelector(".diff__add")).toBeNull();
  });

  it("puts the numbers first on the Overview and leaves the folder path out", async () => {
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    const { Overview } = await import("../src/pages/Overview");
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <Overview />
      </DaemonProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Needs you/ })); // the Codex session; the page opens on Running
    const stats = document.querySelector(".stats")!;
    const meta = [...document.querySelectorAll(".mono.muted")].find((n) => /gpt-5-codex/.test(n.textContent ?? ""))!;
    expect(stats.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // stats come before the text line
    expect(meta.textContent).not.toContain("/Users/"); // no path
    expect(document.querySelector(".stats .diff__add")).toBeTruthy();
    expect(document.querySelector(".stats .diff__del")).toBeTruthy();
  });
});

describe("the token record on the Overview", () => {
  it("shows the total with its breakdown, and says plainly when tracking is off", async () => {
    window.history.replaceState({}, "", "/?tokens=1");
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    window.history.replaceState({}, "", "/");
    const { Overview } = await import("../src/pages/Overview");
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <Overview />
      </DaemonProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Running/ }));
    fireEvent.click(screen.getByRole("button", { name: /auth-service/ }));
    const stat = screen.getByText("Tokens").closest(".stat") as HTMLElement;
    expect(stat.textContent).toContain("4.6M reported"); // fresh input + output
    expect(stat.textContent).toContain("input 3.5M · output 1.1M · cache 289M");
    expect(stat.getAttribute("title")).toContain("cache 289M");
  });

  it("formats the breakdown and the wording for each state", async () => {
    const { usageDetail, usageSummary } = await import("../src/lib/format");
    const s = session();
    expect(usageSummary(s)).toBe("not reported");
    expect(usageSummary(s, true)).toBe("not reported");
    expect(usageSummary(s, false)).toBe("tracking off");
    expect(usageSummary(session({ provider: "codex" }), false)).toBe("not reported"); // the switch is for Claude Code
    expect(usageSummary(session({ provider: "generic" }))).toBe("unavailable");
    expect(usageDetail({ usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0, scope: "session", providerReported: true } })).toBe("input 1.2k · output 300");
    expect(usageDetail({})).toBeUndefined();
    const { tokens } = await import("../src/lib/format");
    expect([999, 61_400, 999_999, 1_000_000, 4_626_000, 289_100_000, 2_500_000_000].map(tokens)).toEqual(["999", "61.4k", "1.0M", "1.0M", "4.6M", "289M", "2.5B"]);
  });
});

describe("a fixed window", () => {
  it("scrolls only the content: the top bar and navigation are outside the scrolling area, and a new page starts at the top", async () => {
    const { Shell } = await import("../src/components/Shell");
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    const scrollTo = vi.fn();
    (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    window.location.hash = "#/";
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <Shell>
          <p>page</p>
        </Shell>
      </DaemonProvider>,
    );
    const main = document.querySelector("main.main")!;
    expect(main.closest(".topbar, .sidebar")).toBeNull();
    expect(document.querySelector("header.topbar")!.contains(main)).toBe(false);
    expect(document.querySelector("nav.sidebar")!.contains(main)).toBe(false);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    scrollTo.mockClear();
    act(() => {
      window.location.hash = "#/sessions";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 }); // changing page goes back to the top
    delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
    window.location.hash = "";
  });
});

describe("the context window meter", () => {
  const ctx = (used: number, over: Partial<{ window: number; windowAuto: boolean; setup: number; conversation: number; tools: number }> = {}) =>
    session({ usage: { scope: "session", providerReported: true, context: { used, window: 1_000_000, windowAuto: true, setup: 21_000, conversation: 38_000, tools: 124_000, ...over } } });

  it("shows what is used of the window, what each part takes, and what is left", () => {
    render(<ContextMeter session={ctx(183_000)} />);
    const meter = screen.getByRole("meter", { name: "Context window" });
    expect(meter.getAttribute("aria-valuenow")).toBe("183000");
    expect(meter.getAttribute("aria-valuemax")).toBe("1000000");
    expect(meter.getAttribute("aria-valuetext")).toBe("18% used, 817k left");
    const widths = [...meter.querySelectorAll("i")].map((n) => (n as HTMLElement).style.width);
    expect(widths).toEqual(["2.1%", "3.8%", "12.4%"]); // setup, conversation, tools as a share of the whole window
    const text = document.body.textContent!;
    expect(text).toContain("183k");
    expect(text).toContain("≈1.0M"); // an estimated window says so
    expect(text).toContain("18%");
    expect(text).toMatch(/setup 21\.0k.*chat 38\.0k.*tools 124k.*817k left/);
  });

  it("says the window is the user's choice when it was pinned, and explains the estimate in its tooltip", () => {
    const { container } = render(<ContextMeter session={ctx(183_000, { windowAuto: false, window: 200_000 })} />);
    expect(document.body.textContent).toContain("/ 200k");
    expect(document.body.textContent).not.toContain("≈");
    expect(container.querySelector(".ctx")!.getAttribute("title")).toMatch(/estimate/);
    expect(container.querySelector(".ctx")!.getAttribute("title")).toMatch(/Window size set in Settings/);
  });

  it("warns at 75% and at 90%, and never draws past the end of the bar", () => {
    expect([0, 0.5, 0.749, 0.75, 0.89, 0.9, 1.2].map((f) => contextLevel(f * 1000, 1000))).toEqual(["ok", "ok", "ok", "warn", "warn", "crit", "crit"]);
    const { container } = render(<ContextMeter session={ctx(1_300_000, { setup: 600_000, conversation: 400_000, tools: 300_000 })} />);
    expect(container.querySelector(".ctx")!.className).toContain("ctx--crit");
    const total = [...container.querySelectorAll(".ctx__seg")].reduce((n, i) => n + parseFloat((i as HTMLElement).style.width), 0);
    expect(total).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("0 left"); // nothing left, not a negative number
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("1000000");
  });

  it("says why there is no meter: another provider, tracking off, or not read yet", () => {
    const { rerender } = render(<ContextMeter session={session()} />);
    expect(screen.getByText("not read yet")).toBeTruthy();
    rerender(<ContextMeter session={session()} tracking={false} />);
    expect(screen.getByText("tracking off")).toBeTruthy();
    rerender(<ContextMeter session={session({ provider: "codex" })} tracking={false} />);
    expect(screen.getByText("tracking off")).toBeTruthy(); // Codex is read like Claude Code
    rerender(<ContextMeter session={session({ provider: "gemini-cli" })} tracking={false} />);
    expect(screen.getByText("not reported")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("is on the Overview next to the tokens", async () => {
    window.history.replaceState({}, "", "/?tokens=1");
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    window.history.replaceState({}, "", "/");
    const { Overview } = await import("../src/pages/Overview");
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <Overview />
      </DaemonProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Running/ }));
    fireEvent.click(screen.getByRole("button", { name: /auth-service/ }));
    const stats = document.querySelector(".stats")!;
    expect(stats.querySelector('[role="meter"]')).toBeTruthy();
    const labels = [...stats.querySelectorAll(".label")].map((n) => n.textContent);
    expect(labels).toEqual(["Elapsed", "Tokens", "Context", "Files", "Diff"]);
  });
});

describe("the context grid", () => {
  const reported = { used: 839_400, window: 1_000_000, windowAuto: false, setup: 33_600, conversation: 805_800, tools: 0, reported: true, buffer: 33_000, categories: [{ name: "System prompt", tokens: 2400 }, { name: "System tools", tokens: 14_600 }, { name: "Skills", tokens: 10_000 }, { name: "Messages", tokens: 805_800 }] };
  const estimated = { used: 420_000, window: 1_000_000, windowAuto: true, setup: 21_000, conversation: 92_000, tools: 307_000 };
  const withCtx = (c: typeof reported | typeof estimated) => session({ model: "claude-sonnet-5-5", usage: { scope: "session", providerReported: true, context: c } });

  it("lists Claude Code's own categories, then free space and the compaction buffer, and the estimate when /context was not run", () => {
    expect(contextParts(reported).map((p) => [p.name, p.kind])).toEqual([["System prompt", "used"], ["System tools", "used"], ["Skills", "used"], ["Messages", "used"], ["Free space", "free"], ["Autocompact buffer", "buffer"]]);
    expect(contextParts(reported).find((p) => p.kind === "free")!.tokens).toBe(1_000_000 - 839_400 - 33_000);
    expect(contextParts(estimated).map((p) => p.name)).toEqual(["Setup (system prompt, tools, memory)", "Conversation", "Tool calls and results", "Free space"]);
  });

  it("gives every part that has tokens at least one cell, and always fills exactly the grid", () => {
    for (const c of [reported, estimated, { ...estimated, used: 1_000_000, tools: 887_000 }, { ...estimated, used: 3000, setup: 3000, conversation: 0, tools: 0 }]) {
      const parts = contextParts(c);
      const cells = allocateCells(parts, c.window);
      expect(cells).toHaveLength(GRID_CELLS);
      for (const p of parts) if (p.tokens > 0) expect(cells.includes(p.key), p.name).toBe(true);
    }
    const cells = allocateCells(contextParts(estimated), 1_000_000);
    const count = (k: string) => cells.filter((x) => x === k).length;
    expect(count("free")).toBe(116); // 58% of 200
    expect(count("chat")).toBeGreaterThanOrEqual(18); // 9.2%
  });

  it("draws the grid and the list, saying where the numbers come from", () => {
    const { container, rerender } = render(<ContextPanel session={withCtx(reported)} />);
    expect(container.querySelectorAll(".ctxp__cell")).toHaveLength(GRID_CELLS);
    expect(container.querySelectorAll(".ctxp__cell--free").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".ctxp__cell--buffer").length).toBe(7); // 33k of 1M
    expect(screen.getByText(/Usage by category · from \/context/)).toBeTruthy();
    expect(screen.getByText("Autocompact buffer")).toBeTruthy();
    expect(container.textContent).toContain("839k");
    expect(container.textContent).toContain("(84%)");
    expect(container.textContent).not.toContain("≈"); // the window is the one Claude Code reported
    rerender(<ContextPanel session={withCtx(estimated)} />);
    expect(screen.getByText("Estimated usage by category")).toBeTruthy();
    expect(container.textContent).toContain("≈1.0M");
    expect(container.textContent).toMatch(/Run \/context in the session/);
  });

  it("explains why there is nothing to draw", () => {
    const { rerender } = render(<ContextPanel session={session()} />);
    expect(screen.getByText("The context window has not been read yet")).toBeTruthy();
    rerender(<ContextPanel session={session()} tracking={false} />);
    expect(screen.getByRole("link", { name: "Open Settings" }).getAttribute("href")).toBe("#/settings");
    // each tool says what is true of it: Codex is read like Claude Code, the others are not read at all
    rerender(<ContextPanel session={session({ provider: "codex" })} />);
    expect(screen.getByText("The context window has not been read yet")).toBeTruthy();
    expect(screen.getByText(/Codex's session file/)).toBeTruthy();
    expect(screen.queryByText(/Claude Code/)).toBeNull();
    rerender(<ContextPanel session={session({ provider: "gemini-cli" })} />);
    expect(screen.getByText("Context is not shown for Gemini CLI")).toBeTruthy();
    expect(screen.getByText("Gemini CLI does not tell AgentWatch how full its window is.")).toBeTruthy();
  });

  it("draws a Codex session's context with Codex's own wording, never Claude Code's", () => {
    const codex = { used: 39_368, window: 258_400, windowAuto: false, setup: 32_234, conversation: 3_449, tools: 3_685 };
    const { container } = render(<ContextPanel session={session({ provider: "codex", model: "gpt-6-luna", usage: { scope: "session", providerReported: true, context: codex } })} />);
    expect(container.querySelectorAll(".ctxp__cell")).toHaveLength(GRID_CELLS);
    expect(container.textContent).toContain("gpt-6-luna");
    expect(container.textContent).toContain("(15%)");
    expect(container.textContent).not.toContain("≈"); // Codex states its window
    expect(screen.getByText("Estimated usage by category")).toBeTruthy();
    expect(screen.getByText(/The total and the window size are Codex's own/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/Claude Code|\/context|Autocompact/);
  });

  it("opens from the meter above the graph: a click brings the Context tab back", () => {
    window.history.replaceState({}, "", "/?tokens=1&reported=1");
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    window.history.replaceState({}, "", "/");
    const s = [...mock.data.sessions].find((x) => x.id === "s1")!;
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <ContextMeter session={s} />
        <AgentGraph session={s} agents={[mainAgent("s1")]} events={[]} />
      </DaemonProvider>,
    );
    expect(screen.getByRole("tab", { name: "Context" }).getAttribute("aria-selected")).toBe("true"); // it is where the panel starts
    expect(document.querySelectorAll(".ctxp__cell")).toHaveLength(GRID_CELLS);
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    fireEvent.click(screen.getByRole("button", { name: /Context/ })); // the meter brings it back from another tab
    expect(screen.getByRole("tab", { name: "Context" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelectorAll(".ctxp__cell")).toHaveLength(GRID_CELLS);
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    act(() => void window.dispatchEvent(new CustomEvent(OPEN_CONTEXT_EVENT))); // the same thing by keyboard or script
    expect(screen.getByRole("tab", { name: "Context" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("the connection badge", () => {
  async function badge(status: "connected" | "connecting" | "disconnected") {
    const { Shell } = await import("../src/components/Shell");
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <Shell>
          <p>page</p>
        </Shell>
      </DaemonProvider>,
    );
    act(() => store.setStatus(status)); // the mock connects on its own; this puts it in the state under test
    return document.querySelector(".sidebar__foot .conn") as HTMLElement;
  }

  it("is a green badge with a sonar dot when the service is connected", async () => {
    const el = await badge("connected");
    expect(el.className).toBe("conn conn--ok");
    expect(el.textContent).toBe("agentwatchd connected");
    expect(el.getAttribute("role")).toBe("status");
    expect(el.querySelector(".conn__dot")).toBeTruthy();
  });

  it("is amber while it connects and red when it cannot be reached, and neither ripples", async () => {
    expect((await badge("connecting")).className).toBe("conn conn--wait");
    cleanup();
    const down = await badge("disconnected");
    expect(down.className).toBe("conn conn--down");
    expect(down.textContent).toBe("agentwatchd not reachable");
    const rel = "../src/styles/app.css"; // a variable, so the bundler does not turn it into an asset URL
    const css = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(css).toMatch(/\.conn--ok \.conn__dot::before/); // only the connected badge has the sonar rings
    expect(css).toMatch(/@keyframes conn-sonar \{ 0% \{ transform: scale\(1\); opacity: 0\.65; \} 100% \{ transform: scale\(3\.2\); opacity: 0; \} \}/); // small: three times the dot, fading out
    expect(css).not.toMatch(/\.conn--down[^{]*::before/);
  });
});

describe("the top bar badges", () => {
  async function bar() {
    const { Shell } = await import("../src/components/Shell");
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <Shell>
          <p>page</p>
        </Shell>
      </DaemonProvider>,
    );
    return store;
  }

  it("shows every count and the local-only note as the same kind of badge, coloured by what it says", async () => {
    await bar();
    const badges = [...document.querySelectorAll(".topbar__right .badge")] as HTMLElement[];
    const byText = (t: RegExp) => badges.find((b) => t.test(b.textContent ?? ""))!;
    expect(byText(/running/).className).toBe("badge badge--run"); // the mock has a running session
    expect(byText(/needs you/).className).toBe("badge badge--ask");
    expect(byText(/local only/).className).toBe("badge badge--muted badge--lock");
    expect(byText(/local only/).querySelector("svg")).toBeTruthy(); // the lock
    expect(document.querySelector(".topbar__right .pill, .topbar__right .lock")).toBeNull();
  });

  it("goes quiet (grey) when nothing is running", async () => {
    const store = await bar();
    act(() => {
      for (const s of [...store.getState().sessions.values()]) store.apply({ type: "removed", sessionId: s.id });
    });
    const running = [...document.querySelectorAll(".topbar__right .badge")].find((b) => /running/.test(b.textContent ?? ""))!;
    expect(running.textContent).toBe("0 running");
    expect(running.className).toBe("badge badge--muted");
    expect(running.querySelector(".dot--run")).toBeNull();
  });
});

describe("the window asks for you when an approval is open", () => {
  async function shell() {
    const { Shell } = await import("../src/components/Shell");
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <Shell>
          <p>page</p>
        </Shell>
      </DaemonProvider>,
    );
    return store;
  }

  it("draws a yellow light around the frame for as long as a request is open, and not a moment longer", async () => {
    const store = await shell();
    const pending = [...store.getState().requests.values()].filter((r) => r.status === "pending");
    expect(pending.length).toBeGreaterThan(0); // the mock has a session waiting on approval
    const frame = document.querySelector(".app > .attn");
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute("aria-hidden")).toBe("true"); // decorative, and it never takes a click
    expect(document.querySelector(".app")!.getAttribute("data-attention")).toBe("1");
    act(() => {
      for (const r of pending) store.apply({ type: "request", request: { ...r, status: "resolved" } });
    });
    expect(document.querySelector(".attn")).toBeNull();
    expect(document.querySelector(".app")!.hasAttribute("data-attention")).toBe(false);
  });

  it("flashes again for a request that is new, and not when another one is answered", async () => {
    const store = await shell();
    const first = document.querySelector(".attn")!;
    const [one] = [...store.getState().requests.values()].filter((r) => r.status === "pending");
    act(() => void store.apply({ type: "request", request: { ...one!, id: "second-ask", status: "pending" } }));
    const afterNew = document.querySelector(".attn")!;
    expect(afterNew).not.toBe(first); // a fresh element restarts the entrance
    act(() => void store.apply({ type: "request", request: { ...one!, id: "second-ask", status: "resolved" } }));
    expect(document.querySelector(".attn")).toBe(afterNew); // answering one while another is open does not re-flash
  });

  it("styles the glow and the badge with the ask colour and stops moving for people who ask for less motion", () => {
    const rel = "../src/styles/app.css";
    const css = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(css).toMatch(/\.attn::before \{[^}]*animation: attn-slam[^}]*attn-breathe/);
    expect(css).toMatch(/@keyframes attn-ripple/);
    expect(css).toMatch(/\.badge--ask \{ animation: ask-pop/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \* \{ animation: none !important/);
    // soft all the way out: every shadow of the frame glow has a blur, so no edge is drawn
    const glow = [css.match(/\.attn::before \{[^}]*\}/)![0], css.match(/@keyframes attn-ripple \{.*\}/)![0]].join("\n");
    expect(glow).not.toMatch(/inset 0 0 0 /);
    for (const m of glow.matchAll(/inset 0 0 (\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(30);
  });
});
