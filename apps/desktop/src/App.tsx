import { useEffect } from "react";
import { Shell } from "./components/Shell";
import { useRoute } from "./lib/router";
import { Agents } from "./pages/Agents";
import { Commands } from "./pages/Commands";
import { Files } from "./pages/Files";
import { Logs } from "./pages/Logs";
import { MenuBar } from "./pages/MenuBar";
import { Onboarding } from "./pages/Onboarding";
import { Overview } from "./pages/Overview";
import { SessionDetail } from "./pages/SessionDetail";
import { Sessions } from "./pages/Sessions";
import { Settings } from "./pages/Settings";

function onboarded(): boolean {
  try {
    return localStorage.getItem("aw.onboarded") === "1";
  } catch {
    return true;
  }
}

export function App() {
  const route = useRoute();
  const [first] = route.segments;

  // First launch: show the setup screen once, before anything is monitored.
  useEffect(() => {
    if (!window.location.hash && !onboarded() && !new URLSearchParams(window.location.search).has("mock")) window.location.hash = "#/onboarding";
  }, []);

  if (first === "menubar") return <MenuBar />;
  if (first === "onboarding") return <Onboarding />;

  let page;
  switch (first) {
    case undefined:
      page = <Overview />;
      break;
    case "sessions":
      page = route.segments[1] ? <SessionDetail id={route.segments[1]} /> : <Sessions />;
      break;
    case "agents":
      page = <Agents />;
      break;
    case "files":
      page = <Files />;
      break;
    case "commands":
      page = <Commands />;
      break;
    case "logs":
      page = <Logs />;
      break;
    case "settings":
      page = <Settings />;
      break;
    default:
      page = <Overview />;
  }
  return <Shell>{page}</Shell>;
}
