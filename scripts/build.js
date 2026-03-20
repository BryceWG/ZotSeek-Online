const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const isDev = args.includes('--dev');
const isWatch = args.includes('--watch');

const buildDir = path.resolve(__dirname, '../build');
const srcDir = path.resolve(__dirname, '../src');

// Ensure build directory exists
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

function cleanBuildDir() {
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });
}

// Copy static files
function copyStaticFiles() {
  const staticDirs = ['content', 'locale', 'skin'];

  for (const dir of staticDirs) {
    const srcPath = path.resolve(__dirname, '..', dir);
    const destPath = path.resolve(buildDir, dir);

    if (fs.existsSync(srcPath)) {
      fs.cpSync(srcPath, destPath, { recursive: true });
      console.log(`Copied ${dir}/`);

      if (dir === 'content') {
        fs.rmSync(path.resolve(destPath, 'models'), { recursive: true, force: true });
        fs.rmSync(path.resolve(destPath, 'wasm'), { recursive: true, force: true });
      }
    }
  }

  // Copy manifest.json
  const manifestSrc = path.resolve(__dirname, '../manifest.json');
  const manifestDest = path.resolve(buildDir, 'manifest.json');
  if (fs.existsSync(manifestSrc)) {
    fs.copyFileSync(manifestSrc, manifestDest);
    console.log('Copied manifest.json');
  }

  // Copy bootstrap.js if it exists
  const bootstrapSrc = path.resolve(__dirname, '../bootstrap.js');
  const bootstrapDest = path.resolve(buildDir, 'bootstrap.js');
  if (fs.existsSync(bootstrapSrc)) {
    fs.copyFileSync(bootstrapSrc, bootstrapDest);
    console.log('Copied bootstrap.js');
  }

  // Copy prefs.js if it exists (default preferences)
  const prefsSrc = path.resolve(__dirname, '../prefs.js');
  const prefsDest = path.resolve(buildDir, 'prefs.js');
  if (fs.existsSync(prefsSrc)) {
    fs.copyFileSync(prefsSrc, prefsDest);
    console.log('Copied prefs.js');
  }
}

// Polyfill browser globals expected by bundled code
const polyfillBanner = `
// Polyfills for Zotero's privileged context
if (typeof self === 'undefined') {
  var self = typeof globalThis !== 'undefined' ? globalThis :
             typeof window !== 'undefined' ? window :
             typeof global !== 'undefined' ? global : this;
}
if (typeof navigator === 'undefined') {
  var navigator = { userAgent: 'Zotero', hardwareConcurrency: 4 };
}
`;

// Build configuration
const buildOptions = {
  entryPoints: [path.resolve(srcDir, 'index.ts')],
  bundle: true,
  outfile: path.resolve(buildDir, 'content/scripts/index.js'),
  format: 'iife',
  // No globalName - we attach to Zotero directly in the script
  platform: 'browser',
  target: ['firefox128'],  // Zotero 8 uses Firefox 128+ ESR
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  banner: {
    js: polyfillBanner,
  },
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },
  external: [],
  logLevel: 'info',
};

// Search dialog with VTable build configuration
const searchDialogBuildOptions = {
  entryPoints: [path.resolve(srcDir, 'ui/search-dialog-vtable.ts')],
  bundle: true,
  outfile: path.resolve(buildDir, 'content/scripts/search-dialog-vtable.js'),
  format: 'iife',
  platform: 'browser',
  target: ['firefox128'],
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },
  external: [],
  logLevel: 'info',
};

// Similar documents dialog build configuration
const similarDocsBuildOptions = {
  entryPoints: [path.resolve(srcDir, 'ui/similar-documents-dialog.ts')],
  bundle: true,
  outfile: path.resolve(buildDir, 'content/scripts/similar-documents-dialog.js'),
  format: 'iife',
  platform: 'browser',
  target: ['firefox128'],
  minify: !isDev,
  sourcemap: isDev ? 'inline' : false,
  define: {
    'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
  },
  external: [],
  logLevel: 'info',
};


async function build() {
  try {
    cleanBuildDir();
    copyStaticFiles();

    if (isWatch) {
      const ctx = await esbuild.context(buildOptions);
      await ctx.watch();
      console.log('Watching for changes...');
    } else {
      // Build main plugin
      await esbuild.build(buildOptions);
      console.log('Main bundle complete!');

      // Build search dialog with VTable
      console.log('Building search dialog with VirtualizedTable...');
      await esbuild.build(searchDialogBuildOptions);
      console.log('Search dialog bundle complete!');
      
      await esbuild.build(similarDocsBuildOptions);
      console.log('Similar documents dialog bundle complete!');
      
      console.log('Build complete!');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
