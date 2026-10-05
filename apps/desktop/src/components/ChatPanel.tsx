import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionView } from "@agentwatch/protocol";
import { parseBlocks, type Block, type ChatMessage, type ChatPolicy, type Inline } from "../lib/chat";
import { clock, providerLabel } from "../lib/format";
import { ProviderIcon, UiIcon } from "./icons";
import { EmptyState } from "./ui";
import "../styles/chat.css";

const reduced = (): boolean => {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => (p.t === "code" ? <code key={i}>{p.text}</code> : p.t === "bold" ? <b key={i}>{p.text}</b> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === "code")
          return (
            <pre key={i} className="chat__code" data-lang={b.lang || undefined}>
              <code>{b.text}</code>
            </pre>
          );
        if (b.t === "heading")
          return (
            <p key={i} className="chat__h">
              <Inlines parts={b.inline} />
            </p>
          );
        if (b.t === "list") {
          const Tag = b.ordered ? "ol" : "ul";
          return (
            <Tag key={i} className="chat__list">
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inlines parts={it} />
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={i}>
            <Inlines parts={b.inline} />
          </p>
        );
      })}
    </>
  );
}

/** A message that arrives while you watch is written out quickly instead of appearing at once. */
function useReveal(text: string, animate: boolean): string {
  const [n, setN] = useState(animate && !reduced() ? 0 : text.length);
  useEffect(() => {
    if (!animate || reduced() || n >= text.length) {
      if (n !== text.length) setN(text.length);
      return;
    }
    let raf = 0;
    const step = Math.max(4, Math.ceil(text.length / 70)); // about a second and a bit, whatever the length
    const tick = () => {
      setN((v) => Math.min(text.length, v + step));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, animate, n >= text.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return text.slice(0, n);
}

function Bubble({ m, provider, animate, onGrow }: { m: ChatMessage; provider: string; animate: boolean; onGrow: () => void }) {
  const shown = useReveal(m.body, animate);
  const blocks = useMemo(() => parseBlocks(shown), [shown]);
  useLayoutEffect(onGrow, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = m.role === "user";
  return (
    <div className={`chat__msg chat__msg--${m.role}`} data-role={m.role}>
      <div className="chat__who">
        {mine ? <UiIcon name="user" size={13} /> : <ProviderIcon provider={provider} size={13} />}
        <span>{mine ? "You" : providerLabel[provider] ?? "Assistant"}</span>
        <time>{clock(m.at)}</time>
      </div>
      <div className="chat__bubble">
        <Blocks blocks={blocks} />
        {shown.length < m.body.length && <span className="chat__caret" aria-hidden="true" />}
      </div>
    </div>
  );
}

/** The conversation of one session as a chat. Off unless the person has turned message storage on in Settings. */
export function ChatPanel({ session, messages, policy }: { session: SessionView; messages: ChatMessage[]; policy: ChatPolicy }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(messages.map((m) => m.id)); // what is there when you open it is not "new"

  const toBottom = () => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(toBottom, [messages.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAway(!stick.current);
  };

  if (!policy.prompts && !policy.responses) {
    return (
      <EmptyState
        icon="messages-square"
        title="Chat is off"
        hint="AgentWatch normally keeps only what the agent did. To read the conversation here, turn on Store prompt text and Store assistant responses in Settings. The text stays on this Mac, credentials are redacted, and turning it off deletes it."
        action={{ label: "Open Settings", href: "#/settings" }}
      />
    );
  }
  if (session.provider !== "claude-code" && messages.length === 0) {
    return <EmptyState compact icon="messages-square" title="Chat is not available for this session" hint="Only Claude Code conversations can be shown for now." />;
  }
  if (messages.length === 0) {
    return (
      <EmptyState
        compact
        icon="messages-square"
        title="No messages yet"
        hint={!policy.responses ? "Assistant responses are off in Settings, so only your prompts will appear." : !policy.prompts ? "Your prompts are off in Settings, so only the assistant's replies will appear." : "Messages appear here as the conversation continues."}
      />
    );
  }

  const last = messages[messages.length - 1]!;
  const working = (session.status === "running" || session.status === "waiting") && last.role === "user" && !session.endedAt;
  return (
    <div className="chat" aria-label="Conversation">
      {(!policy.prompts || !policy.responses) && (
        <p className="chat__note">{!policy.responses ? "Assistant responses are off in Settings: only your prompts are shown." : "Your prompts are off in Settings: only the assistant's replies are shown."}</p>
      )}
      <div className="chat__scroll" ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
        {messages.map((m) => {
          const fresh = !seen.current!.has(m.id);
          return <Bubble key={m.id} m={m} provider={session.provider} animate={fresh && m.role === "assistant"} onGrow={toBottom} />;
        })}
        {working && (
          <div className="chat__msg chat__msg--assistant" aria-label={`${providerLabel[session.provider] ?? "The assistant"} is working`}>
            <div className="chat__bubble chat__working" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>
      {away && (
        <button
          type="button"
          className="chat__jump"
          onClick={() => {
            stick.current = true;
            toBottom();
            setAway(false);
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
