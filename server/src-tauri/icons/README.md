Empty on purpose. Before running `npm run tauri:build` on macOS:

1. Generate the app-bundle icon set from a 1024x1024 source image:
   ```
   cd server
   npx tauri icon path/to/logo-1024.png
   ```
   Produces `32x32.png`, `128x128.png`, `128x128@2x.png`, and `icon.icns`
   here, matching `tauri.conf.json`'s `bundle.icon` list.

2. Separately, add `tray-icon.png` — a small (~22x22 @1x / 44x44 @2x)
   template-style icon (black shapes on transparent background) for the
   menu-bar tray. This is used at runtime by `src/main.rs`'s
   `TrayIconBuilder`, not by the bundler, so it isn't in `tauri.conf.json`.
