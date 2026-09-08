// Writes the page for a packaged build.
//
//   node scripts/write-page.mjs --manifest game.json --out build/index.html \
//                               --library fusion-runtime.js --package game.zip
//   node scripts/write-page.mjs --manifest game.json --out build/game.html \
//                               --library dist/fusion-runtime.js --inline game.zip
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
import { readFileSync, writeFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const manifestPath = args.get('manifest');
const out = args.get('out');
const library = args.get('library');
const inline = args.get('inline');
const packageName = args.get('package');

if (!manifestPath || !out || !library || (!inline && !packageName)) {
  console.error('usage: write-page.mjs --manifest <game.json> --out <file> --library <module>' +
    ' (--package <name> | --inline <game.zip>)');
  process.exit(1);
}

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

// The running game is left on the window: nothing in the page needs it, but it is what there is
// to reach for from a console.
const script = `import { play } from ${JSON.stringify(libraryUrl)};
      window.fusion = await play({ package: ${JSON.stringify(packageUrl)}, canvas: 'game' });`;

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
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
  `${size > 100_000 ? ` (${(size / 1048576).toFixed(1)} MB)` : ''}`);

function dataUrl(type, bytes) {
  return `data:${type};base64,${bytes.toString('base64')}`;
}

function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
