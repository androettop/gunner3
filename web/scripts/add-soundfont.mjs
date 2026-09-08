// Puts the instruments the game's music needs into a package.
//
//   node scripts/add-soundfont.mjs --package game.zip --soundfont GeneralUserGS.sf3
//
// The music is MIDI, which is a score and not a sound: it names General MIDI instruments and
// carries none of them, so the runtime plays it against a soundfont. A whole General MIDI bank
// is 8 MB and this game reaches about a fifth of it, so the bank is cut down here to the
// presets its fifteen tracks actually ask for, down to which keys of them are ever struck, and
// only that goes into the package.
//
// The cut is made against the package's own MIDI files, so it is the game that decides what a
// build carries. The soundfont is read and written compressed, and never decoded on the way
// through: what would be 13 MB of samples stays under 3 MB.
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { BasicMIDI, BasicSoundBank, SoundBankLoader } from 'spessasynth_core';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const pkg = args.get('package');
const soundfont = args.get('soundfont');

if (!pkg || !soundfont) {
  console.error('usage: add-soundfont.mjs --package <game.zip> --soundfont <bank.sf3>');
  process.exit(1);
}

/** fflate hands back views on a shared buffer; the parsers want a buffer of their own. */
const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

const files = unzipSync(readFileSync(pkg));
const tracks = Object.keys(files).filter((name) => name.endsWith('.mid')).sort();
if (!tracks.length) {
  console.error(`${pkg} has no music in it; nothing to do`);
  process.exit(0);
}

await BasicSoundBank.isSF3DecoderReady;
const bank = SoundBankLoader.fromArrayBuffer(buffer(readFileSync(soundfont)));
const whole = { presets: bank.presets.length, samples: bank.samples.length };

// What every track asks for, together: a preset, and under it the keys and velocities that are
// ever played on it. Anything else is what gets left behind.
const used = new Map();
for (const name of tracks) {
  const midi = BasicMIDI.fromArrayBuffer(buffer(files[name]));
  for (const [preset, keys] of midi.getUsedProgramsAndKeys(bank)) {
    const into = used.get(preset) ?? new Map();
    used.set(preset, into);
    for (const [key, velocities] of keys) {
      const at = into.get(key) ?? new Set();
      into.set(key, at);
      for (const velocity of velocities) at.add(velocity);
    }
  }
}

bank.trim(used);
const written = new Uint8Array(bank.writeSF2());

// Its samples are compressed already, so the zip is told not to spend the time trying again.
// Everything else in the package is packed as it was.
writeFileSync(pkg, zipSync({ ...files, 'soundfont.sf3': [written, { level: 0 }] }, { level: 9 }));

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;
console.log(`soundfont: ${bank.presets.length} of ${whole.presets} presets, ` +
  `${bank.samples.length} of ${whole.samples} samples, ${mb(written.length)}`);
