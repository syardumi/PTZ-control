#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct ServerState(Mutex<Option<CommandChild>>);

fn spawn_server(app: &AppHandle) {
    let state = app.state::<ServerState>();
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return; // already running
    }

    let ffmpeg_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("ffmpeg")))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let (mut rx, child) = app
        .shell()
        .sidecar("ptz-server")
        .expect("failed to create ptz-server sidecar command")
        .env("PTZ_FFMPEG_PATH", ffmpeg_path)
        .spawn()
        .expect("failed to spawn ptz-server sidecar");

    *guard = Some(child);
    drop(guard);

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stdout(line) | CommandEvent::Stderr(line) = event {
                println!("[ptz-server] {}", String::from_utf8_lossy(&line));
            }
        }
    });
}

fn stop_server(app: &AppHandle) {
    let state = app.state::<ServerState>();
    if let Some(child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerState(Mutex::new(None)))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let start_item = MenuItem::with_id(app, "start", "Start Server", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "Stop Server", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&start_item, &stop_item, &PredefinedMenuItem::separator(app)?, &quit_item],
            )?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("PTZ Control Server")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "start" => spawn_server(app),
                    "stop" => stop_server(app),
                    "quit" => {
                        stop_server(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            spawn_server(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building PTZ Control Server")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                stop_server(app_handle);
            }
        });
}
