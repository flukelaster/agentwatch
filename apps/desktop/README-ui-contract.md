# UI contract for page authors

- Design source of truth: `../../design/artboards/*.dc.html` (relative to this folder) (final, approved look). Match layout, copy and states. Use the same tokens through the CSS variables in `src/styles/tokens.css` and the shared classes in `src/styles/app.css`.
- Shared pieces you may import but must NOT edit: `src/components/ui.tsx`, `src/components/Shell.tsx`, `src/components/AgentGraph.tsx`, `src/lib/*`, `src/styles/app.css`, `src/styles/tokens.css`, `src/App.tsx`.
- Put page-specific CSS in your own `src/styles/<page>.css` and import it from your page module.
- Data: `useLive()` for the live read model; `useQuery(name, params)` for history; `useDaemon().client.command(name, params)` for actions.
- Privacy rules shown in the UI must stay true: never invent data, say "not reported"/"unavailable" when unknown, observed (low-confidence) changes are never attributed to an agent.
