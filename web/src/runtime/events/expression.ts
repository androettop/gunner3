import type { FusionInstance } from '../instance';
import type { FrameScene } from '../scene';
import type { ParamDef } from '../../data/types';

/**
 * Evaluator for Fusion expression streams.
 *
 * A parameter's expression is a flat token list in infix order. This game only ever uses ten
 * token kinds and never nests deeper than `operand operator operand`, so a left-to-right fold
 * with no precedence handling reproduces it exactly.
 */

const CONST_INT = key(-1, 0);
const CONST_STRING = key(-1, 3);
const OP_ADD = key(0, 2);
const OP_SUB = key(0, 4);
const OBJ_Y = key(2, 1);
const OBJ_DIR = key(2, 6);
const OBJ_X = key(2, 11);
const OBJ_ALTERABLE = key(2, 16);
const COUNTER_VALUE = key(7, 80);
const INI_READ = key(32, 80);

function key(objectType: number, num: number): string {
  return `${objectType}:${num}`;
}

interface Token {
  ObjectType: number;
  Num: number;
  ObjectInfo: number;
  Expression?: { Value?: number | string };
}

/**
 * How an object named inside an expression resolves to an instance.
 *
 * `X("Enemy")` does not mean "the first enemy in the level": it means the enemy the event is
 * currently working on. Callers that know the event's selection pass their own resolver, so an
 * action stepping through ten enemies reads each one's own position rather than the first one's
 * ten times over.
 */
export type Resolve = (objectId: number) => FusionInstance | undefined;

export function evaluate(scene: FrameScene, param: ParamDef | undefined, resolve?: Resolve): number {
  const value = evaluateAny(scene, param, resolve);
  return typeof value === 'number' ? value : Number(value) || 0;
}

export function evaluateString(
  scene: FrameScene,
  param: ParamDef | undefined,
  resolve?: Resolve,
): string {
  const value = evaluateAny(scene, param, resolve);
  return typeof value === 'string' ? value : String(value);
}

export function evaluateAny(
  scene: FrameScene,
  param: ParamDef | undefined,
  resolve?: Resolve,
): number | string {
  const tokens = (param?.data?.['Expressions'] ?? []) as Token[];
  if (!tokens.length) return 0;

  const pick: Resolve = resolve ?? ((id) => scene.instancesOf(id)[0]);
  let accumulator = operand(pick, scene, tokens[0]);
  let index = 1;

  while (index < tokens.length) {
    const op = key(tokens[index].ObjectType, tokens[index].Num);
    const rhs = tokens[index + 1];
    if (rhs === undefined) break;

    const right = operand(pick, scene, rhs);
    const a = Number(accumulator) || 0;
    const b = Number(right) || 0;

    if (op === OP_ADD) accumulator = typeof accumulator === 'string' ? accumulator + String(right) : a + b;
    else if (op === OP_SUB) accumulator = a - b;
    else accumulator = a; // Unknown operator: keep the left side rather than poisoning the result.

    index += 2;
  }

  return accumulator;
}

function operand(pick: Resolve, scene: FrameScene, token: Token): number | string {
  const kind = key(token.ObjectType, token.Num);
  const raw = token.Expression?.Value;

  switch (kind) {
    case CONST_INT:
      return typeof raw === 'number' ? raw : Number(raw) || 0;
    case CONST_STRING:
      return typeof raw === 'string' ? raw : String(raw ?? '');
    case OBJ_X:
      return pick(token.ObjectInfo)?.x ?? 0;
    case OBJ_Y:
      return pick(token.ObjectInfo)?.y ?? 0;
    case OBJ_DIR:
      return pick(token.ObjectInfo)?.direction ?? 0;
    case OBJ_ALTERABLE: {
      const index = typeof raw === 'number' ? raw : 0;
      return pick(token.ObjectInfo)?.values[index] ?? 0;
    }
    case COUNTER_VALUE:
      // Counters keep their reading in alterable value 0.
      return pick(token.ObjectInfo)?.values[0] ?? 0;
    case INI_READ:
      // Read through the INI object the expression names: each holds its own file, group and
      // item, so which object is asked decides which value comes back.
      return scene.ini.read(token.ObjectInfo);
    default:
      return 0;
  }
}

