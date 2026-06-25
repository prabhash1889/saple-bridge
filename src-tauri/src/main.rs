// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "mcp" {
        let project_path = args[2].clone();
        saple_bridge_lib::run_mcp(project_path);
    } else {
        saple_bridge_lib::run();
    }
}
