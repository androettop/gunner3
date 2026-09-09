// Puts the configuration files a game ships with into its package.
//
//   node scripts/add-defaults.mjs --package game.zip --ini g4_temp.ini [--ini save/temp ...]
//
// A Clickteam game is not only its executable. Gunner 4 keeps the player's key bindings in an
// INI file next to it, reads them on the intro screen and asks the control object about those
// key codes from then on; without the file nothing the player presses reaches the game. The
// original ships one filled in with the defaults, and this puts a copy where the runtime can
// find it, so a browser that has never run the game starts as the download does.
//
// They are written under `defaults/`, keyed by the path the game asks for. The INI store reads
// one only when it has nothing of its own for that file, so a player's own settings, once
// saved, always win.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { unzipSync, zipSync } from 'fflate';

const args = [];
for (let i = 2; i < process.argv.length; i += 2) args.push([process.argv[i].replace(/^--/, ''), process.argv[i + 1]]);
const pkg = args.find(([k]) => k === 'package')?.[1];
const inis = args.filter(([k]) => k === 'ini').map(([, v]) => v);

if (!pkg || !inis.length) {
  console.error('usage: add-defaults.mjs --package <game.zip> --ini <file.ini> [--ini <file.ini>]');
  process.exit(1);
}

/**
 * An INI file as the store keeps it: groups of named items.
 *
 * The files are DOS text and Windows-1252, and a value may hold anything up to the line's end,
 * so only the first `=` splits it.
 */
function parseIni(text) {
  const contents = {};
  let group = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      group = line.slice(1, -1);
      contents[group] ??= {};
      continue;
    }
    const split = line.indexOf('=');
    if (split < 0 || group === null) continue;
    contents[group][line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return contents;
}

const files = unzipSync(readFileSync(pkg));
const encoder = new TextEncoder();

for (const path of inis) {
  const contents = parseIni(readFileSync(path, 'latin1'));
  const groups = Object.keys(contents).length;
  // The runtime looks these up by the name the game asks for, which is the file's own.
  const name = `defaults/${basename(path).toLowerCase()}`;
  files[name] = encoder.encode(JSON.stringify(contents));
  console.log(`${name}: ${groups} group${groups === 1 ? '' : 's'} from ${path}`);
}

writeFileSync(pkg, zipSync(files, { level: 9 }));
