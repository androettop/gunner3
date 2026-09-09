// Cross-checks every opcode appearing in a game's event tables against the interpreter's
// registries, so coverage is verified statically rather than by whatever a play session hits.
//
// It reads a built package: web/public/game.zip by default, or $GAME_PACKAGE, which is what
// tools/package.sh points at the one it has just made. There is no game in this repository to
// check against, so with no package this says so and passes: coverage is a check on a copy of
// the original, not a build step.
//
// Three things decide whether an opcode is covered, and the check models all three:
//
//   - the opcode tables in runtime/events/opcodes.ts, keyed by object type and number;
//   - the common opcodes, which are registered once against the Active object and reached from
//     every other object type;
//   - the extension registry in runtime/events/extensions.ts, which is keyed by the extension an
//     object belongs to rather than by its type, since a type number means different extensions
//     in different games.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(process.env.GAME_PACKAGE ?? resolve(here, '../public/game.zip'));
const opcodeSource = readFileSync(resolve(here, '../src/runtime/events/opcodes.ts'), 'utf8');
const extensionSource = readFileSync(resolve(here, '../src/runtime/events/extensions.ts'), 'utf8');
const expressionSource = readFileSync(resolve(here, '../src/runtime/events/expression.ts'), 'utf8');

if (!existsSync(pkg)) {
  console.log(`No game package at ${pkg}; skipping the opcode coverage check.`);
  process.exit(0);
}

/** The `'type:num':` keys of one table in opcodes.ts. */
function registry(name) {
  const start = opcodeSource.indexOf(`export const ${name}`);
  const end = opcodeSource.indexOf('\n};', start);
  return new Set([...opcodeSource.slice(start, end).matchAll(/'(-?\d+:-?\d+)':/g)].map((m) => m[1]));
}

/** The body of a braced block starting at `from`, by matching braces. */
function block(source, from) {
  const open = source.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let at = open; at < source.length; at++) {
    if (source[at] === '{') depth++;
    else if (source[at] === '}' && --depth === 0) return source.slice(open + 1, at);
  }
  return '';
}

/** How the extension registry resolves an object to a set of handlers, and what each set holds. */
function extensions() {
  const byIdentifier = new Map();
  for (const [, key, name] of block(extensionSource, extensionSource.indexOf('const BY_IDENTIFIER'))
    .matchAll(/'?([\w+]+)'?\s*:\s*'(\w+)'/g)) {
    byIdentifier.set(key, name);
  }

  const ambiguous = new Map();
  const ambiguousBody = block(extensionSource, extensionSource.indexOf('const AMBIGUOUS'));
  for (const match of ambiguousBody.matchAll(/'?([\w+]+)'?\s*:\s*\{/g)) {
    const inner = block(ambiguousBody, match.index);
    const names = new Map();
    for (const [, objectName, set] of inner.matchAll(/'([^']+)'\s*:\s*'(\w+)'/g)) names.set(objectName, set);
    ambiguous.set(match[1], names);
  }

  const sets = new Map();
  const body = block(extensionSource, extensionSource.indexOf('const EXTENSIONS'));
  for (const match of body.matchAll(/^ {2}(\w+):\s*\{/gm)) {
    const inner = block(body, match.index);
    const kinds = {};
    for (const kind of ['actions', 'conditions', 'expressions']) {
      const at = inner.indexOf(`${kind}: {`);
      kinds[kind] = at < 0
        ? new Set()
        // Positive opcodes are written as plain keys, negative ones as computed `[-87]:`.
        : new Set([...block(inner, at).matchAll(/^\s{6}\[?(-?\d+)\]?:/gm)].map((m) => Number(m[1])));
    }
    sets.set(match[1], kinds);
  }
  return { byIdentifier, ambiguous, sets };
}

const conditions = registry('CONDITIONS');
const actions = registry('ACTIONS');
const { byIdentifier, ambiguous, sets } = extensions();
/** The expression tokens the evaluator reads, as `type:num` keys. */
const expressions = new Set(
  [...expressionSource.matchAll(/key\((-?\d+),\s*(-?\d+)\)/g)].map((m) => `${m[1]}:${m[2]}`),
);

const files = unzipSync(readFileSync(pkg), {
  filter: (file) =>
    file.name === 'game.json' || (file.name.startsWith('events/') && file.name.endsWith('.json')),
});
const decode = (name) => JSON.parse(new TextDecoder().decode(files[name]));
const manifest = decode('game.json');

/** Objects by id, for resolving an opcode's object to the extension it belongs to. */
const objects = new Map(manifest.objects.map((object) => [object.id, object]));

function setFor(objectInfo) {
  const object = objects.get(objectInfo);
  const identifier = object?.detail?.identifier;
  if (!identifier) return null;
  const name = ambiguous.has(identifier)
    ? ambiguous.get(identifier).get(object.name)
    : byIdentifier.get(identifier);
  return name ? (sets.get(name) ?? null) : null;
}

/**
 * Whether an opcode resolves to a handler, by the same three steps the interpreter takes.
 */
function covered(ace, kind) {
  const key = `${ace.objectType}:${ace.num}`;
  const table = kind === 'conditions' ? conditions : actions;
  if (table.has(key)) return true;

  if (ace.objectType >= 32 && setFor(ace.objectInfo)?.[kind].has(ace.num)) return true;

  // Common opcodes are registered against the Active object and shared by every other type.
  const isCommon = kind === 'conditions' ? ace.num > -81 : ace.num < 80;
  return ace.objectType > 2 && isCommon && table.has(`2:${ace.num}`);
}

const missing = { conditions: new Map(), actions: new Map(), expressions: new Map() };
let events = 0;

function note(kind, key, count = 1) {
  missing[kind].set(key, (missing[kind].get(key) ?? 0) + count);
}

for (const name of Object.keys(files)) {
  if (name === 'game.json') continue;
  for (const event of decode(name).events) {
    events++;
    for (const [kind, list] of [['conditions', event.conditions], ['actions', event.actions]]) {
      for (const ace of list) {
        if (!covered(ace, kind)) note(kind, `${ace.objectType}:${ace.num}`);
        for (const parameter of ace.parameters) {
          for (const token of parameter.data?.Expressions ?? []) {
            const key = `${token.ObjectType}:${token.Num}`;
            if (expressions.has(key)) continue;
            // Readings below 80 are the common set, registered against the Active object and
            // shared by every other object type.
            if (token.ObjectType > 2 && token.Num < 80 && expressions.has(`2:${token.Num}`)) continue;
            if (token.ObjectType >= 32 && setFor(token.ObjectInfo)?.expressions.has(token.Num)) continue;
            note('expressions', key);
          }
        }
      }
    }
  }
}

const report = (label, map) =>
  console.log(`missing ${label.padEnd(11)} ${map.size ? [...map].map((e) => e.join(',')).join('  ') : 'none'}`);

console.log(`events: ${events}`);
console.log(`conditions implemented: ${conditions.size}, actions implemented: ${actions.size}`);
report('conditions', missing.conditions);
report('actions', missing.actions);
report('expressions', missing.expressions);
process.exit(missing.conditions.size || missing.actions.size || missing.expressions.size ? 1 : 0);
