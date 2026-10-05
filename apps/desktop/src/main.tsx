import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { disableSchemaJit } from "@agentwatch/protocol";
import "./styles/app.css";
import { App } from "./App";
import { WsDaemonClient } from "./lib/client";
import { DaemonProvider, type Daemon } from "./lib/context";
import { MockDaemonClient } from "./lib/mock";
import { LiveStore } from "./lib/store";
import { applyTheme, followThemeChanges, loadTheme } from "./lib/themes";

disableSchemaJit();
// before anything is drawn, so there is no flash of the wrong theme; and every open window follows a change
applyTheme(loadTheme());
followThemeChanges();

const store = new LiveStore();
const useMock = new URLSearchParams(window.location.search).has("mock") || import.meta.env.VITE_MOCK === "1";
const daemon: Daemon = { store, client: useMock ? new MockDaemonClient(store) : new WsDaemonClient(store) };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DaemonProvider daemon={daemon}>
      <App />
    </DaemonProvider>
  </StrictMode>,
);
