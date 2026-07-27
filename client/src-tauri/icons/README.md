Empty on purpose. Before running `npm run tauri:build` on macOS, generate the
required icon set from a 1024x1024 source image:

```
cd client
npx tauri icon path/to/logo-1024.png
```

This produces `32x32.png`, `128x128.png`, `128x128@2x.png`, and `icon.icns`
in this folder, which `tauri.conf.json`'s `bundle.icon` list points at.
