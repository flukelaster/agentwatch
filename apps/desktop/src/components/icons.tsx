import { useId, type SVGProps } from "react";

/**
 * The marks are decorative: the provider's name is always written next to them.
 * Brand marks come from TheSVG (thesvg.org), pasted inline with their own colours: `claude-code` keeps its brand
 * orange, `gemini-cli` its gradient and `google-antigravity` its blue; `codex-openai` and `cursor` follow the text colour (their brand colour is
 * white, which is what a dark surface wants).
 * Generic glyphs come from Lucide. Nothing here loads from a network.
 */

type P = Omit<SVGProps<SVGSVGElement>, "width" | "height" | "name"> & { size?: number };

export function ClaudeCodeMark({ size = 16, ...rest }: P) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" data-icon-source="thesvg:claude-code" {...rest}>
      <path
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
        fill="#D97757"
        fillRule="evenodd"
      />
    </svg>
  );
}

export function CodexMark({ size = 16, ...rest }: P) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" aria-hidden="true" data-icon-source="thesvg:codex-openai" {...rest}>
      <path
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  );
}

export function GeminiCliMark({ size = 16, ...rest }: P) {
  const id = useId(); // gradient ids must be unique per instance, or one removed mark takes the others' fill with it
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width={size} height={size} fill="none" aria-hidden="true" data-icon-source="thesvg:gemini-cli" {...rest}>
      <path d="m45.8 0.09h164.1c25.35 0 45.83 20.72 45.83 46.3v163.1c0 25.58-21 46.33-46.48 46.33h-163.2c-25.48 0-45.99-21.16-45.99-46.3v-162.9c0-25.77 20.75-46.52 45.76-46.52z" fill={`url(#${id}a)`} />
      <path d="m46.82 14.06h161.9c18.49 0 32.5 15.43 32.5 33.06v161.8c0 18.33-14.53 32.49-32.56 32.49h-161.7c-18.03 0-32.86-13.85-32.86-32.27v-162.4c0-17.66 14.43-32.61 32.76-32.61z" fill="#1F1D2E" />
      <path d="m76.93 62.08 102.2 49.64v38.76l-102.4 49.43v-28.46l82.28-40.62-82.06-39.3v-29.45z" fill={`url(#${id}b)`} />
      <defs>
        <linearGradient id={`${id}a`} x1="10.83" x2="245.5" y1="24.31" y2="238.7" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0083FF" offset="0" />
          <stop stopColor="#2384FF" offset=".23" />
          <stop stopColor="#0186FF" offset=".41" />
          <stop stopColor="#A774DB" offset=".59" />
          <stop stopColor="#E0597A" offset=".83" />
          <stop stopColor="#E0597A" offset="1" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="71.54" x2="162.7" y1="100.5" y2="151.2" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0186FF" offset="0" />
          <stop stopColor="#0186FF" offset=".5" />
          <stop stopColor="#B878D6" offset=".96" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** The arch from TheSVG's `google-antigravity`, in one of its brand blues: the full mark is eleven blurred gradient layers, too heavy to repeat on every row. */
export function AntigravityMark({ size = 16, ...rest }: P) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 15" width={size} height={size} fill="none" aria-hidden="true" data-icon-source="thesvg:google-antigravity" {...rest}>
      <path
        d="M14.0777 13.984C14.945 14.6345 16.2458 14.2008 15.0533 13.0084C11.476 9.53949 12.2349 0 7.79033 0C3.34579 0 4.10461 9.53949 0.527295 13.0084C-0.773543 14.3092 0.635692 14.6345 1.50293 13.984C4.86344 11.7076 4.64663 7.69664 7.79033 7.69664C10.934 7.69664 10.7172 11.7076 14.0777 13.984Z"
        fill="#3186FF"
      />
    </svg>
  );
}

export function CursorMark({ size = 16, ...rest }: P) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 466.73 532.09" width={size} height={size} fill="currentColor" aria-hidden="true" data-icon-source="thesvg:cursor" {...rest}>
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  );
}

/** The provider's mark; a generic CLI gets the terminal glyph. */
export function ProviderIcon({ provider, size = 16, ...rest }: P & { provider: string }) {
  if (provider === "claude-code") return <ClaudeCodeMark size={size} {...rest} />;
  if (provider === "codex") return <CodexMark size={size} {...rest} />;
  if (provider === "gemini-cli") return <GeminiCliMark size={size} {...rest} />;
  if (provider === "antigravity") return <AntigravityMark size={size} {...rest} />;
  if (provider === "cursor") return <CursorMark size={size} {...rest} />;
  return <UiIcon name="terminal" size={size} {...rest} />;
}

/** Which provider an evidence source belongs to (for the marks on graph source nodes). */
export const sourceProvider = (source: string | undefined): string | undefined =>
  source?.startsWith("claude") ? "claude-code" : source?.startsWith("codex") ? "codex" : source?.startsWith("gemini") ? "gemini-cli" : source?.startsWith("antigravity") ? "antigravity" : source?.startsWith("cursor") ? "cursor" : undefined;

const LUCIDE = {
  inbox: (
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  terminal: (
    <>
      <path d="M12 19h8" />
      <path d="m4 17 6-6-6-6" />
    </>
  ),
  "file-text": (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>
  ),
  "messages-square": (
    <>
      <path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      <path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" />
    </>
  ),
  activity: <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />,
  search: (
    <>
      <path d="m21 21-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </>
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  "scroll-text": (
    <>
      <path d="M15 12h-5" />
      <path d="M15 8h-5" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
    </>
  ),
  "folder-open": <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />,
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  "shield-check": (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  sparkles: (
    <>
      <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
      <path d="M20 2v4" />
      <path d="M22 4h-4" />
      <circle cx="4" cy="20" r="2" />
    </>
  ),
  "git-branch": (
    <>
      <path d="M15 6a9 9 0 0 0-9 9V3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </>
  ),
} as const;

export type UiIconName = keyof typeof LUCIDE;

export function UiIcon({ name, size = 16, ...rest }: P & { name: UiIconName }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon-source={`lucide:${name}`} {...rest}>
      {LUCIDE[name]}
    </svg>
  );
}
