//! AgentWatch desktop shell: a menu-bar item, a dashboard window and a popover, and the owner of the daemon.
//!
//! Design goals, in order: work after install with nothing to run, and cost almost nothing while idle.
//!  - The app starts its own daemon from the Node runtime bundled inside the .app, and the daemon exits by
//!    itself if the app disappears (`--parent`), so nothing can be orphaned.
//!  - With every window closed the app is only this Rust process: no WebView exists. Windows are created on
//!    demand; the popover is destroyed a minute after it is hidden.
//!  - The status item's numbers come from a tiny push stream from the daemon, not from a WebView.
//!  - The shell never touches the network. It talks to the daemon over a Unix socket.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, Position, RunEvent, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const TRAY_ID: &str = "main";
const POPOVER_IDLE_DESTROY: Duration = Duration::from_secs(60);

/// Diagnostics only (AGENTWATCH_POPOVER_ON_START): keep the popover open when focus moves elsewhere.
static POPOVER_PINNED: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);
static POPOVER_GEN: AtomicU64 = AtomicU64::new(0);
/// When a window was last closed (ms since the epoch). Used to tell "the last window closed" from a real quit.
static LAST_CLOSE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Closing the last window makes macOS ask to exit; that must keep the app alive in the menu bar.
/// A genuine quit (Cmd+Q, the Dock menu, shutdown) arrives with no window having just closed, and must go through.
fn exit_is_just_a_window_closing() -> bool {
    now_ms().saturating_sub(LAST_CLOSE_MS.load(Ordering::Relaxed)) < 1500
}

#[derive(Default)]
struct DaemonChild(Mutex<Option<Child>>);

fn data_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("AGENTWATCH_HOME") {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library").join("Application Support").join("AgentWatch")
}

fn socket_path() -> PathBuf {
    data_dir().join("agentwatchd.sock")
}

fn daemon_live() -> bool {
    UnixStream::connect(socket_path()).is_ok()
}

/// One request/response over the daemon's Unix socket (newline-delimited JSON).
fn ipc(op: &str) -> Result<serde_json::Value, String> {
    let mut stream = UnixStream::connect(socket_path()).map_err(|_| "agentwatchd is not running".to_string())?;
    let timeout = Some(Duration::from_millis(1500));
    stream.set_read_timeout(timeout).ok();
    stream.set_write_timeout(timeout).ok();
    let frame = serde_json::json!({ "op": op }).to_string() + "\n";
    stream.write_all(frame.as_bytes()).map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|e| e.to_string())
}

/// A single-use, 60-second capability for the UI's first WebSocket frame.
#[tauri::command]
fn mint_capability() -> Result<serde_json::Value, String> {
    let v = ipc("mint")?;
    if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
        Ok(v)
    } else {
        Err("the daemon refused to mint a capability".into())
    }
}

// ---------------------------------------------------------------- daemon ownership

struct Runtime {
    node: PathBuf,
    daemon: PathBuf,
    cli: PathBuf,
}

/// The Node runtime and bundles shipped inside the .app. None when running from a dev build.
fn runtime(app: &AppHandle) -> Option<Runtime> {
    // Worked out from where the executable sits (Contents/MacOS -> Contents/Resources) instead of trusting
    // the framework's resolver, which fails with UnknownPath for an app that lives under a temp directory.
    let exe = std::env::current_exe().ok()?;
    let beside = exe.parent()?.parent()?.join("Resources").join("runtime");
    let dir = if beside.join("agentwatchd.mjs").exists() { beside } else { app.path().resource_dir().ok()?.join("runtime") };
    let daemon = dir.join("agentwatchd.mjs");
    if !daemon.exists() {
        return None;
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let node = exe_dir.join("node");
    Some(Runtime { node: if node.exists() { node } else { PathBuf::from("node") }, daemon, cli: dir.join("agentwatch.mjs") })
}

/// The app's own notes about what it tried (starting the daemon, mostly). Small, local, never uploaded.
fn app_log(msg: &str) {
    let dir = data_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("app.log");
    if fs::metadata(&path).map(|m| m.len() > 200_000).unwrap_or(false) {
        let _ = fs::remove_file(&path);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {msg}", now_ms());
    }
}

fn open_log() -> Option<fs::File> {
    let dir = data_dir();
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("daemon.log");
    if fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = fs::remove_file(&path);
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn spawn_daemon(app: &AppHandle) -> Result<Child, String> {
    let rt = runtime(app).ok_or_else(|| format!("no bundled runtime next to {:?}", std::env::current_exe()))?;
    raise_fd_limit();
    let log = open_log();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&rt.node);
    cmd.args(["--max-old-space-size=128", "--disable-warning=ExperimentalWarning"])
        .arg(&rt.daemon)
        .args(["--parent", &std::process::id().to_string()])
        .env("AGENTWATCH_NODE", &rt.node)
        .env("AGENTWATCH_CLI_SCRIPT", &rt.cli)
        .env("AGENTWATCH_APP_EXE", exe)
        .stdin(Stdio::null())
        .process_group(0);
    match log {
        Some(f) => {
            let f2 = f.try_clone().map_err(|e| e.to_string())?;
            cmd.stdout(f).stderr(f2);
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    cmd.spawn().map_err(|e| format!("could not start the daemon: {e}"))
}

/// A process started from the Dock or Finder gets a soft limit of 256 open files (a terminal gets far more). The
/// daemon watches directories and spawns git for every open session, so give it, and everything it starts, room.
fn raise_fd_limit() {
    // SAFETY: plain getrlimit/setrlimit calls on a zero-initialised struct.
    unsafe {
        let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
            return;
        }
        let want = std::cmp::min(lim.rlim_max, 10_240);
        if lim.rlim_cur < want {
            let before = lim.rlim_cur;
            lim.rlim_cur = want;
            if libc::setrlimit(libc::RLIMIT_NOFILE, &lim) == 0 {
                app_log(&format!("open-file limit raised from {before} to {want}"));
            }
        }
    }
}

fn ensure_daemon(app: &AppHandle) {
    if daemon_live() {
        return;
    }
    match spawn_daemon(app) {
        Ok(child) => {
            app_log(&format!("started daemon pid {}", child.id()));
            if let Some(state) = app.try_state::<DaemonChild>() {
                if let Ok(mut slot) = state.0.lock() {
                    *slot = Some(child);
                }
            }
        }
        Err(e) => app_log(&format!("could not start daemon: {e}")),
    }
}

fn stop_daemon(app: &AppHandle) {
    if let Some(state) = app.try_state::<DaemonChild>() {
        if let Ok(mut slot) = state.0.lock() {
            if let Some(mut child) = slot.take() {
                // SIGTERM lets the daemon close SQLite cleanly; the parent watchdog is the backstop
                let _ = Command::new("/bin/kill").arg(child.id().to_string()).status();
                let deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                let _ = child.kill();
            }
        }
    }
}

/// Keeps the daemon alive while the app runs, without hammering: at most 5 starts per minute.
fn supervise_daemon(app: AppHandle) {
    std::thread::spawn(move || {
        let mut starts: Vec<Instant> = Vec::new();
        loop {
            std::thread::sleep(Duration::from_secs(5));
            if QUITTING.load(Ordering::Relaxed) {
                return;
            }
            if !daemon_live() {
                starts.retain(|t| t.elapsed() < Duration::from_secs(60));
                if starts.len() < 5 {
                    starts.push(Instant::now());
                    ensure_daemon(&app);
                } else if starts.len() == 5 {
                    starts.push(Instant::now()); // log the give-up once per minute, not every 5 seconds
                    app_log("the daemon keeps stopping; not restarting it again for a minute. See daemon.log");
                }
            }
        }
    });
}

// ---------------------------------------------------------------- tray

fn tray_title(running: u64, waiting: u64, failed: u64) -> String {
    match (waiting, failed) {
        (0, 0) if running == 0 => String::new(),
        (0, 0) => format!(" {running}"),
        (w, 0) => format!(" {running} · {w} !"),
        (0, f) => format!(" {running} · {f} ✕"),
        (w, f) => format!(" {running} · {w} ! · {f} ✕"),
    }
}

fn update_tray(app: &AppHandle, running: u64, waiting: u64, failed: u64) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let title = tray_title(running, waiting, failed);
        let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
        let _ = tray.set_tooltip(Some(format!("AgentWatch: {running} running, {waiting} need you, {failed} failed")));
    }
}

/// The status item's numbers come from a push stream on the daemon's socket, so they stay current with no WebView.
fn watch_tray(app: AppHandle) {
    std::thread::spawn(move || loop {
        if QUITTING.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(mut stream) = UnixStream::connect(socket_path()) {
            if stream.write_all(b"{\"op\":\"watch\"}\n").is_ok() {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        let s = &v["summary"];
                        let n = |k: &str| s[k].as_u64().unwrap_or(0);
                        update_tray(&app, n("running"), n("waiting"), n("failed"));
                    }
                }
            }
            update_tray(&app, 0, 0, 0);
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}

// ---------------------------------------------------------------- windows (created on demand)

fn create_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(label) {
        return Ok(w);
    }
    let cfg = app.config().app.windows.iter().find(|w| w.label == label).ok_or("unknown window")?.clone();
    WebviewWindowBuilder::from_config(app, &cfg).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())
}

fn set_dock_visible(app: &AppHandle, visible: bool) {
    let _ = app.set_activation_policy(if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
}

fn hide_popover(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("menubar") {
        let _ = w.hide();
        schedule_popover_destroy(app);
    }
}

/// A hidden popover still holds a whole WebView. Drop it a minute after it was last shown.
fn schedule_popover_destroy(app: &AppHandle) {
    let gen = POPOVER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(POPOVER_IDLE_DESTROY);
        if POPOVER_GEN.load(Ordering::SeqCst) != gen || POPOVER_PINNED.load(Ordering::Relaxed) {
            return;
        }
        if let Some(w) = app.get_webview_window("menubar") {
            if !w.is_visible().unwrap_or(false) {
                let _ = w.destroy();
            }
        }
    });
}

fn show_main(app: &AppHandle, path: Option<&str>) -> Result<(), String> {
    set_dock_visible(app, true);
    let w = create_window(app, "main")?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    if let Some(p) = path {
        // only in-app hash routes are accepted
        if p.starts_with('/') && !p.contains(['"', '\\', '\n']) {
            let js = format!("window.location.hash = {};", serde_json::to_string(&format!("#{p}")).unwrap_or_default());
            let _ = w.eval(&js);
        }
    }
    hide_popover(app);
    Ok(())
}

#[tauri::command]
fn show_main_window(app: AppHandle, path: Option<String>) -> Result<(), String> {
    show_main(&app, path.as_deref())
}

/// Where the popover's top-left goes: centered under the status item, then clamped so it never
/// hangs off the edge of the display the item is on. All values are physical pixels.
fn popover_origin(item: (f64, f64, f64, f64), win_w: f64, screen: (f64, f64, f64), margin: f64) -> (i32, i32) {
    let (ix, iy, iw, ih) = item;
    let (sx, _sy, sw) = screen;
    let centered = ix + iw / 2.0 - win_w / 2.0;
    let lo = sx + margin;
    let hi = (sx + sw - win_w - margin).max(lo);
    (centered.clamp(lo, hi).round() as i32, (iy + ih).round() as i32)
}

fn toggle_popover(app: &AppHandle, anchor: Option<(PhysicalPosition<i32>, f64, f64)>) {
    if let Some(w) = app.get_webview_window("menubar") {
        if w.is_visible().unwrap_or(false) {
            hide_popover(app);
            return;
        }
    }
    let Ok(w) = create_window(app, "menubar") else { return };
    POPOVER_GEN.fetch_add(1, Ordering::SeqCst); // cancel a pending destroy
    if let Some((pos, width, height)) = anchor {
        let win_w = w.outer_size().map(|s| s.width as f64).unwrap_or(380.0);
        let mon = app.monitor_from_point(pos.x as f64, pos.y as f64).ok().flatten().or_else(|| app.primary_monitor().ok().flatten());
        let screen = mon.map(|m| (m.position().x as f64, m.position().y as f64, m.size().width as f64)).unwrap_or((0.0, 0.0, 1.0e9));
        let scale = w.scale_factor().unwrap_or(1.0);
        let (x, y) = popover_origin((pos.x as f64, pos.y as f64, width, height), win_w, screen, 8.0 * scale);
        let _ = w.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    }
    let _ = w.show();
    let _ = w.set_focus();
}

fn show_popover_at_corner(app: &AppHandle) {
    let Ok(w) = create_window(app, "menubar") else { return };
    let Ok(Some(mon)) = app.primary_monitor() else { return };
    let scale = mon.scale_factor();
    let win_w = w.outer_size().map(|s| s.width as f64).unwrap_or(380.0 * scale);
    let x = mon.position().x as f64 + mon.size().width as f64 - win_w - 16.0 * scale;
    let y = mon.position().y as f64 + 30.0 * scale;
    let _ = w.set_position(Position::Physical(PhysicalPosition::new(x.round() as i32, y.round() as i32)));
    let _ = w.show();
    let _ = w.set_focus();
}

fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::Relaxed);
    stop_daemon(app);
    app.exit(0);
}

pub fn run() {
    let hidden = std::env::args().any(|a| a == "--hidden");

    let app = tauri::Builder::default()
        .manage(DaemonChild::default())
        .invoke_handler(tauri::generate_handler![mint_capability, show_main_window])
        .setup(move |app| {
            let handle = app.handle().clone();
            // `kill`, a logout or a shutdown send SIGTERM: stop the daemon properly instead of just dying.
            let term = Arc::new(AtomicBool::new(false));
            for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
                let _ = signal_hook::flag::register(sig, term.clone());
            }
            let h = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(250));
                if term.load(Ordering::Relaxed) {
                    quit(&h);
                    return;
                }
            });
            ensure_daemon(&handle);
            supervise_daemon(handle.clone());

            let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit AgentWatch", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit_item])?;
            // Template icon: black on transparent, so macOS can tint it for light and dark menu bars.
            let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .icon_as_template(true)
                .tooltip("AgentWatch")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        let _ = show_main(app, None);
                    }
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                        let p = match rect.position {
                            Position::Physical(p) => p,
                            Position::Logical(l) => PhysicalPosition::new(l.x as i32, l.y as i32),
                        };
                        let (w, h) = match rect.size {
                            tauri::Size::Physical(s) => (s.width as f64, s.height as f64),
                            tauri::Size::Logical(s) => (s.width, s.height),
                        };
                        toggle_popover(tray.app_handle(), Some((p, w, h)));
                    }
                })
                .build(app)?;
            watch_tray(handle.clone());

            if hidden {
                // Started at login: tray only, no window, no Dock icon.
                set_dock_visible(&handle, false);
            } else {
                show_main(&handle, None)?;
            }

            // Diagnostics: a crowded menu bar (or a menu-bar manager) can push the status item
            // off-screen. With AGENTWATCH_POPOVER_ON_START=1 the popover opens at the top-right corner.
            if std::env::var_os("AGENTWATCH_POPOVER_ON_START").is_some() {
                POPOVER_PINNED.store(true, Ordering::Relaxed);
                std::thread::spawn({
                    let handle = handle.clone();
                    move || {
                        std::thread::sleep(Duration::from_millis(2500));
                        show_popover_at_corner(&handle);
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            // The popover behaves like a menu: it goes away when it loses focus.
            ("menubar", WindowEvent::Focused(false)) => {
                if !POPOVER_PINNED.load(Ordering::Relaxed) {
                    hide_popover(window.app_handle());
                }
            }
            // Closing the dashboard frees its WebView; monitoring carries on from the menu bar.
            ("main", WindowEvent::Destroyed) => {
                LAST_CLOSE_MS.store(now_ms(), Ordering::Relaxed);
                if !QUITTING.load(Ordering::Relaxed) {
                    set_dock_visible(window.app_handle(), false);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building AgentWatch");

    app.run(|handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            let closing = exit_is_just_a_window_closing();
            app_log(&format!("exit requested (code {code:?}, last window just closed: {closing}, quitting: {})", QUITTING.load(Ordering::Relaxed)));
            if code.is_none() && !QUITTING.load(Ordering::Relaxed) {
                if closing {
                    // Closing the last window must not end the app: it lives in the menu bar.
                    api.prevent_exit();
                } else {
                    // A real quit (Cmd+Q, the Dock menu, Apple Events): stop the daemon, then leave.
                    api.prevent_exit();
                    quit(handle);
                }
            }
        }
        // Clicking the Dock icon brings the dashboard back.
        RunEvent::Reopen { has_visible_windows, .. } if !has_visible_windows => {
            let _ = show_main(handle, None);
        }
        RunEvent::Exit => {
            QUITTING.store(true, Ordering::Relaxed);
            stop_daemon(handle);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{popover_origin, tray_title};

    // a 2x display, 3024 px wide; the popover is 760 px wide (380 pt)
    const SCREEN: (f64, f64, f64) = (0.0, 0.0, 3024.0);

    #[test]
    fn centers_under_the_item_and_sits_below_it() {
        let (x, y) = popover_origin((1500.0, 8.0, 60.0, 48.0), 760.0, SCREEN, 16.0);
        assert_eq!(x, 1500 + 30 - 380);
        assert_eq!(y, 56);
    }

    #[test]
    fn never_hangs_off_the_right_edge() {
        let (x, _) = popover_origin((2990.0, 8.0, 60.0, 48.0), 760.0, SCREEN, 16.0);
        assert_eq!(x, 3024 - 760 - 16);
    }

    #[test]
    fn never_hangs_off_the_left_edge_and_respects_a_second_display() {
        let (x, _) = popover_origin((4.0, 8.0, 60.0, 48.0), 760.0, SCREEN, 16.0);
        assert_eq!(x, 16);
        let (x2, _) = popover_origin((3050.0, 8.0, 60.0, 48.0), 760.0, (3024.0, 0.0, 2560.0), 16.0);
        assert!(x2 >= 3024 + 16);
    }

    #[test]
    fn a_screen_narrower_than_the_window_does_not_panic() {
        let (x, _) = popover_origin((100.0, 0.0, 40.0, 40.0), 760.0, (0.0, 0.0, 500.0), 16.0);
        assert_eq!(x, 16);
    }

    #[test]
    fn only_a_just_closed_window_keeps_the_app_alive() {
        use std::sync::atomic::Ordering;
        super::LAST_CLOSE_MS.store(0, Ordering::Relaxed);
        assert!(!super::exit_is_just_a_window_closing(), "a quit with no window just closed must go through");
        super::LAST_CLOSE_MS.store(super::now_ms(), Ordering::Relaxed);
        assert!(super::exit_is_just_a_window_closing(), "closing the last window must not end the app");
        super::LAST_CLOSE_MS.store(super::now_ms() - 5000, Ordering::Relaxed);
        assert!(!super::exit_is_just_a_window_closing(), "a quit a few seconds later is a real quit");
    }

    #[test]
    fn tray_title_shows_only_what_needs_attention() {
        assert_eq!(tray_title(0, 0, 0), "");
        assert_eq!(tray_title(3, 0, 0), " 3");
        assert_eq!(tray_title(3, 1, 0), " 3 · 1 !");
        assert_eq!(tray_title(3, 0, 2), " 3 · 2 ✕");
        assert_eq!(tray_title(3, 1, 2), " 3 · 1 ! · 2 ✕");
    }
}
