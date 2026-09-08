// Cross-checks every opcode appearing in a game's event tables against the interpreter's
// registries, so coverage is verified statically rather than by whatever a play session hits.
//
// It reads a built package: web/public/game.zip by default, or $GAME_PACKAGE, which is what
// tools/package.sh points at the one it has just made. There is no game in this repository to
// check against, so with no package this says so and passes: coverage is a check on a copy of
// the original, not a build step.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(process.env.GAME_PACKAGE ?? resolve(here, '../public/game.zip'));
const source = readFileSync(resolve(here, '../src/runtime/events/opcodes.ts'), 'utf8');

if (!existsSync(pkg)) {
  console.log(`No game package at ${pkg}; skipping the opcode coverage check.`);
  process.exit(0);
}

function registry(name) {
  const start = source.indexOf(`export const ${name}`);
  const end = source.indexOf('\n};', start);
  return new Set([...source.slice(start, end).matchAll(/'(-?\d+:-?\d+)':/g)].map((m) => m[1]));
}

const conditions = registry('CONDITIONS');
const actions = registry('ACTIONS');

const missingC = new Map();
const missingA = new Map();
let events = 0;

const files = unzipSync(readFileSync(pkg), {
  filter: (file) => file.name.startsWith('events/') && file.name.endsWith('.json'),
});

for (const bytes of Object.values(files)) {
  const data = JSON.parse(new TextDecoder().decode(bytes));
  for (const event of data.events) {
    events++;
    for (const c of event.conditions) {
      const key = `${c.objectType}:${c.num}`;
      if (!conditions.has(key)) missingC.set(key, (missingC.get(key) ?? 0) + 1);
    }
    for (const a of event.actions) {
      const key = `${a.objectType}:${a.num}`;
      if (!actions.has(key)) missingA.set(key, (missingA.get(key) ?? 0) + 1);
    }
  }
}

console.log(`events: ${events}`);
console.log(`conditions implemented: ${conditions.size}, actions implemented: ${actions.size}`);
console.log(`missing conditions: ${missingC.size ? [...missingC] : 'none'}`);
console.log(`missing actions:    ${missingA.size ? [...missingA] : 'none'}`);
process.exit(missingC.size || missingA.size ? 1 : 0);
