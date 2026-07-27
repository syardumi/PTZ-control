// Packages server.js into a standalone macOS executable via @yao-pkg/pkg, and
// copies this machine's bundled ffmpeg binary alongside it — both named per
// Rust's target-triple convention so Tauri's externalBin/sidecar mechanism
// can find and bundle them. Must be run on a Mac (arm64 or x64) to produce
// binaries usable by `tauri build` there. The pkg-compile step itself is
// cross-platform (pkg fetches a prebuilt Node runtime for the target), but
// the ffmpeg-copy step below only runs on macOS since it copies a local
// binary rather than downloading one for another platform.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ARCH_TRIPLE = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' };
const triple = ARCH_TRIPLE[process.arch];
if (!triple) {
  console.error(`Unsupported build arch "${process.arch}" — run this on an Intel or Apple Silicon Mac.`);
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'src-tauri', 'binaries');
fs.mkdirSync(BIN_DIR, { recursive: true });

const pkgTarget = `node22-macos-${process.arch}`;
const serverOut = path.join(BIN_DIR, `ptz-server-${triple}`);
execFileSync('npx', ['@yao-pkg/pkg', 'server.js', '--target', pkgTarget, '--output', serverOut], {
  stdio: 'inherit',
  cwd: ROOT
});
fs.chmodSync(serverOut, 0o755);
console.log(`Wrote ${serverOut}`);

if (os.platform() === 'darwin') {
  const ffmpegSrc = require('@ffmpeg-installer/ffmpeg').path;
  const ffmpegOut = path.join(BIN_DIR, `ffmpeg-${triple}`);
  fs.copyFileSync(ffmpegSrc, ffmpegOut);
  fs.chmodSync(ffmpegOut, 0o755);
  console.log(`Wrote ${ffmpegOut}`);
} else {
  console.warn('Not on macOS — skipping the ffmpeg sidecar copy step (run this script on a Mac before `tauri build` there).');
}
