// Makes a packaged build installable: the web app manifest, and the worker that keeps a copy of
// it in the browser.
//
//   node scripts/write-pwa.mjs --manifest game.json --out build \
//                              --library fusion-runtime.js --package game.zip
//
// Everything an installed app is told about itself is the game's own: its name and its author
// come out of the package, and so does the icon, which the unpacker reads from the executable.
// Nothing here is written by hand except the colours and the shape of the window, which are the
// page's rather than the game's.
//
// Run last, over a build that is otherwise finished: the page and the icons have to be there to
// be cached, and the manifest is written in among them.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const manifestPath = args.get('manifest');
const out = args.get('out');
const library = args.get('library');
const packageName = args.get('package');

if (!manifestPath || !out || !library || !packageName) {
  console.error('usage: write-pwa.mjs --manifest <game.json> --out <dir>' +
    ' --library <module> --package <name>');
  process.exit(1);
}

const game = JSON.parse(readFileSync(manifestPath, 'utf8'));
const name = game.appName || 'Fusion web runtime';

// The game is 640x480 and reads a keyboard: on a phone it wants the whole screen, the long way
// round. Everything else is the page it is played on — black behind the canvas, and the green
// the game itself is drawn in for whatever chrome the system keeps.
const BACKGROUND = '#000000';
const THEME = '#60c028';

// What the unpacker put in the package, under the names the build gives them. An icon the
// executable did not carry is simply not listed.
const icons = [
  { src: 'icon.png', sizes: '32x32' },
  { src: 'icon-192.png', sizes: '192x192' },
  { src: 'icon-512.png', sizes: '512x512' },
  // Kept to the middle of its square, so a phone that rounds or crops an icon cuts into black
  // rather than into the game's own.
  { src: 'icon-maskable.png', sizes: '512x512', purpose: 'maskable' },
].filter((icon) => exists(join(out, icon.src)))
  .map((icon) => ({ ...icon, type: 'image/png' }));

const manifest = {
  name,
  short_name: name,
  description: game.author ? `${name}, by ${game.author}` : name,
  // Relative, so the app is wherever it was installed from: a domain of its own, a project
  // site's subdirectory, or a directory on your own machine.
  start_url: './',
  scope: './',
  display: 'fullscreen',
  orientation: 'landscape',
  background_color: BACKGROUND,
  theme_color: THEME,
  categories: ['games'],
  icons,
};

writeFileSync(join(out, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

// Everything this build is, which is everything a worker has to keep for the game to run with
// no network at all: the page, the library, the package, and what was just written beside them.
// The page is asked for as the directory it is in, which is what a browser asks for when the
// app is opened from its own icon.
const files = ['./', library, packageName, 'manifest.webmanifest', ...icons.map((icon) => icon.src)]
  .filter((file) => exists(join(out, file === './' ? 'index.html' : file)));

// A hash of what is cached, which is what makes the next build a different cache: the worker's
// own text changes with it, so a browser that fetches it sees a new worker and installs it.
const hash = createHash('sha256');
for (const file of files) hash.update(readFileSync(join(out, file === './' ? 'index.html' : file)));
const version = hash.digest('hex').slice(0, 12);

const worker = `// Keeps this build in the browser, so it plays with no network and installs like any app.
//
// Written by scripts/write-pwa.mjs, over a finished build. The cache is named after a hash of
// the files below, so a new build is a new cache: the one before it goes as soon as this worker
// takes over, and nothing is ever served out of a build it did not come from.
const CACHE = ${JSON.stringify(`${cacheName(name)}-${version}`)};
const FILES = ${JSON.stringify(files, null, 2)};

// The page itself, under the name a browser asks for it by.
const PAGE = new URL('./', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const old of await caches.keys()) if (old !== CACHE) await caches.delete(old);
    await self.clients.claim();
  })());
});

// Out of the cache first, and only then the network. A build never changes under its own
// address: what was cached is what was published, and a new build arrives as a new worker.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Anywhere in scope is this one page, however it was linked to.
    const cached = await cache.match(request.mode === 'navigate' ? PAGE : request, { ignoreSearch: true });
    return cached || fetch(request);
  })());
});
`;

writeFileSync(join(out, 'sw.js'), worker);

console.log(`${join(out, 'manifest.webmanifest')}: ${name}, ${icons.length} icons`);
console.log(`${join(out, 'sw.js')}: ${files.length} files cached, version ${version}`);

function exists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// A name for the cache that says which game it holds.
function cacheName(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fusion';
}
