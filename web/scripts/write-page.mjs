// Writes the page for a packaged build.
//
//   node scripts/write-page.mjs --manifest game.json --out build/index.html \
//                               --library fusion-runtime.js --package game.zip --pwa
//   node scripts/write-page.mjs --manifest game.json --out build/game.html \
//                               --library dist/fusion-runtime.js --inline game.zip --icon icon.png
//
// --library is the name the library will sit under beside the page, or, with --inline, the path
// to read it from.
//
// The library is a precompiled ES module that plays a package; it carries no game in it. This
// writes the page that puts the two together: a canvas, an import, and a call naming the
// package. The game's own name becomes the title.
//
// --inline puts the library and the package into the page itself, as one file that runs
// straight off the file system. A page that loads its package over the network cannot: fetching
// a file beside it counts as a cross-origin request there, and the browser refuses.
//
// --icon names the game's icon, which the unpacker read out of the executable and the build
// laid out beside the page. Inlined, it travels in the page like everything else; otherwise its
// being there is what says the sized icons are there too, since they are written together. A
// game whose executable carried no icon has none of this, and the page says nothing about it.
//
// --pwa says the manifest and the worker scripts/write-pwa.mjs writes are beside the page: the
// page then says it can be installed, and puts the worker up once the game is playing.
import { readFileSync, writeFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  // --pwa carries no value of its own, so it does not take the next argument with it.
  if (process.argv[i] === '--pwa') { i -= 1; continue; }
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const manifestPath = args.get('manifest');
const out = args.get('out');
const library = args.get('library');
const inline = args.get('inline');
const packageName = args.get('package');
const iconPath = args.get('icon');
const pwa = process.argv.includes('--pwa');

if (!manifestPath || !out || !library || (!inline && !packageName)) {
  console.error('usage: write-page.mjs --manifest <game.json> --out <file> --library <module>' +
    ' (--package <name> | --inline <game.zip>)');
  process.exit(1);
}

// A build passes the icon it laid out; a game that had none leaves nothing there to read.
const icon = readIcon(iconPath);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const title = manifest.appName || 'Fusion web runtime';

// The page is the canvas and nothing else, on black. Everything a player sees (the loading
// screen included) is drawn on that canvas by the runtime.
const style = `html, body {
        margin: 0;
        height: 100%;
        background: #000;
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      canvas { display: block; image-rendering: pixelated; }`;

// Inlined, the library and the package become data URLs: the page imports and loads exactly
// what it would over the network, so there is one code path rather than two. Importing a module
// from a data URL is what makes this work from the file system, where importing a file beside
// the page does not.
const libraryUrl = inline
  ? dataUrl('text/javascript', readFileSync(library))
  : `./${library}`;
const packageUrl = inline
  ? dataUrl('application/zip', readFileSync(inline))
  : packageName;

// What the page wears and says about itself. A packaged build has the icons and the manifest
// beside it, written by scripts/write-pwa.mjs, which is where the same colour is set. Inlined,
// there is only the page, so the icon travels inside it and there is nothing to install.
const wearing = !icon
  // Nothing to wear: an empty icon, so that the browser does not go looking for one.
  ? [`<link rel="icon" href="data:," />`]
  : inline
    ? [`<link rel="icon" href="${dataUrl('image/png', icon)}" />`]
    : [`<link rel="icon" href="icon.png" />`, `<link rel="apple-touch-icon" href="icon-192.png" />`];
const head = [
  ...wearing,
  pwa && `<link rel="manifest" href="manifest.webmanifest" />`,
  pwa && `<meta name="theme-color" content="#60c028" />`,
  pwa && `<meta name="mobile-web-app-capable" content="yes" />`,
  pwa && `<meta name="apple-mobile-web-app-capable" content="yes" />`,
  pwa && `<meta name="apple-mobile-web-app-status-bar-style" content="black" />`,
].filter(Boolean).join('\n    ');

// The running game is left on the window: nothing in the page needs it, but it is what there is
// to reach for from a console.
const script = `import { play } from ${JSON.stringify(libraryUrl)};
      window.fusion = await play({ package: ${JSON.stringify(packageUrl)}, canvas: 'game' });${pwa ? `

      // The worker keeps a copy of this build, so a second visit plays with no network and the
      // game installs like any other app. It goes up once the game is playing: what it caches
      // is then what the page has just fetched, and nothing waits on it to start. A page opened
      // from a file, or served over plain HTTP, has no workers at all, which is not an error.
      navigator.serviceWorker?.register('sw.js').catch(() => {});` : ''}`;

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${head}
    <title>${escapeHtml(title)}</title>
    <style>
      ${style}
    </style>
  </head>
  <body>
    <canvas id="game"></canvas>
    <script type="module">
      ${script}
    </script>
  </body>
</html>
`;

writeFileSync(out, page);
const size = Buffer.byteLength(page);
console.log(`${out}: ${title}, ${inline ? 'library and package embedded' : `loading ${packageName}`}` +
  `${pwa ? ', installable' : ''}` +
  `${size > 100_000 ? ` (${(size / 1048576).toFixed(1)} MB)` : ''}`);

function readIcon(path) {
  if (!path) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function dataUrl(type, bytes) {
  return `data:${type};base64,${bytes.toString('base64')}`;
}

function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
