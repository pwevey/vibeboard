// @ts-check
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const isWatch = process.argv.includes('--watch');

// === Extension bundle (Node/CommonJS) ===
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: isWatch,
  minify: !isWatch,
  treeShaking: true,
};

// === Webview bundle (Browser/IIFE) ===
const webviewConfig = {
  entryPoints: ['src/ui/webview/main.ts'],
  bundle: true,
  outfile: 'dist/webview/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: isWatch,
  minify: !isWatch,
  treeShaking: true,
};

// Build CSS — minify in production, copy raw in watch mode
async function buildCSS() {
  if (!isWatch) {
    // Use esbuild to minify CSS
    await esbuild.build({
      entryPoints: ['src/ui/webview/styles.css'],
      outfile: 'dist/webview/styles.css',
      minify: true,
      logLevel: 'silent',
    });
    console.log('[vibeboard] CSS minified to dist/webview/');
  } else {
    const src = path.resolve('src/ui/webview/styles.css');
    const dest = path.resolve('dist/webview/styles.css');
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
    console.log('[vibeboard] CSS copied to dist/webview/');
  }
}

async function build() {
  try {
    if (isWatch) {
      const extCtx = await esbuild.context(extensionConfig);
      const webCtx = await esbuild.context(webviewConfig);
      await extCtx.watch();
      await webCtx.watch();
      await buildCSS();
      console.log('[vibeboard] Watching for changes...');
    } else {
      await esbuild.build(extensionConfig);
      await esbuild.build(webviewConfig);
      await buildCSS();
      console.log('[vibeboard] Build complete.');
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

build();
