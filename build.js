/**
 * Scannr — Build Script
 *
 * Uses esbuild to bundle the extension into dist/.
 * Copies static files (manifest, HTML, CSS, icons) alongside bundles.
 *
 * Two build passes:
 *   1. ESM  — background service worker (Chrome MV3 supports module workers)
 *   2. IIFE — content scripts + popup (no ES module support in these contexts)
 *
 * Usage:
 *   node build.js          — one-shot build
 *   node build.js --watch  — watch mode for development
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const isWatch = process.argv.includes('--watch');

// Ensure dist/ exists
if (!fs.existsSync(DIST)) {
  fs.mkdirSync(DIST, { recursive: true });
}

// Static files to copy (source → dest relative to dist/)
const staticFiles = [
  ['manifest.json', 'manifest.json'],
  ['ui/popup.html', 'ui/popup.html'],
  ['ui/popup.css', 'ui/popup.css'],
  ['assets/styles/overlay.css', 'assets/styles/overlay.css'],
];

// Static directories to copy
const staticDirs = [
  ['assets/icons', 'assets/icons'],
];

function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyStatics() {
  for (const [src, dest] of staticFiles) {
    const srcPath = path.join(__dirname, src);
    const destPath = path.join(DIST, dest);
    if (fs.existsSync(srcPath)) {
      copyFile(srcPath, destPath);
    }
  }
  for (const [src, dest] of staticDirs) {
    copyDir(path.join(__dirname, src), path.join(DIST, dest));
  }
  console.log('[build] Static files copied');
}

// Shared options
const sharedOptions = {
  bundle: true,
  outdir: DIST,
  target: ['chrome120'],
  minify: !isWatch,
  sourcemap: isWatch ? 'inline' : false,
  logLevel: 'info',
};

// Pass 1: Background service worker (ESM — Chrome MV3 module workers)
const backgroundBuild = {
  ...sharedOptions,
  entryPoints: [
    { in: path.join(__dirname, 'background/service-worker.js'), out: 'background/service-worker' },
  ],
  format: 'esm',
};

// Pass 2: Content scripts + popup (IIFE — no module support in these contexts)
const contentBuild = {
  ...sharedOptions,
  entryPoints: [
    { in: path.join(__dirname, 'content/overlay.js'), out: 'content/overlay' },
    { in: path.join(__dirname, 'ui/popup.js'), out: 'ui/popup' },
  ],
  format: 'iife',
};

async function build() {
  copyStatics();

  if (isWatch) {
    const [bgCtx, contentCtx] = await Promise.all([
      esbuild.context(backgroundBuild),
      esbuild.context(contentBuild),
    ]);
    await Promise.all([bgCtx.watch(), contentCtx.watch()]);
    console.log('[build] Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(backgroundBuild),
      esbuild.build(contentBuild),
    ]);
    console.log('[build] Done!');
  }
}

build().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
