// Prevents an extra console window on release builds on non-macOS targets.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agentwatch_desktop_lib::run()
}
