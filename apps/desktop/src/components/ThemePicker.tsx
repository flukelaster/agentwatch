import { useEffect, useState } from "react";
import { DEFAULT_THEME, THEMES, THEME_KEY, applyTheme, loadTheme, saveTheme, shade, themeById, type Theme } from "../lib/themes";
import "../styles/themes.css";

/** A small picture of a theme, drawn with that theme's own greys whatever theme is on now. */
function Preview({ theme }: { theme: Theme }) {
  const g = (level: string) => shade(theme, parseInt(level, 16));
  return (
    <span className="themecard__preview" style={{ background: g("05"), borderColor: g("30") }} aria-hidden="true">
      <span className="themecard__panel" style={{ background: g("0b"), borderColor: g("20") }}>
        <i style={{ background: g("ed"), width: "46%" }} />
        <i style={{ background: g("85"), width: "72%" }} />
      </span>
      <span className="themecard__dots">
        <i style={{ background: "var(--run)" }} />
        <i style={{ background: "var(--done)" }} />
        <i style={{ background: "var(--ask)" }} />
        <i style={{ background: "var(--fail)" }} />
      </span>
    </span>
  );
}

/** Choose how dark the interface is. The choice applies at once, in every open window, and is remembered. */
export function ThemePicker() {
  const [current, setCurrent] = useState(loadTheme);

  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === THEME_KEY) setCurrent(themeById(e.newValue ?? DEFAULT_THEME).id);
    };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);

  const choose = (id: string) => {
    applyTheme(id);
    saveTheme(id);
    setCurrent(id);
  };

  return (
    <div className="themes" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={t.id === current} className="themecard" onClick={() => choose(t.id)}>
          <Preview theme={t} />
          <span className="themecard__name">
            {t.name}
            {t.id === DEFAULT_THEME && <small>default</small>}
          </span>
          <span className="themecard__tag">{t.tagline}</span>
        </button>
      ))}
    </div>
  );
}
