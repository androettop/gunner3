import type { FusionInstance } from '../instance';
import type { FrameScene } from '../scene';
import type { ParamDef } from '../../data/types';

/**
 * Evaluator for Fusion expression streams.
 *
 * A parameter's expression is a flat token list in infix order, and reading it takes a parser
 * rather than a fold: Fusion writes `X + Cos(Dir * 11.25) * Radius` with the multiplications
 * binding tighter than the addition, and groups its own sub-expressions in parentheses. Folding
 * the list left to right evaluates that as `((X + Cos(...)) * Radius)`, which is a different
 * number.
 *
 * The grammar is small. Literals and object readings are operands; `+ - * / %` are the binary
 * operators, in two precedence levels; a parenthesis token opens a group and an end-parenthesis
 * closes it. A function is a prefix token that opens its own group: `Random(40)` is written
 * `Random 40 )`, with no opening parenthesis of its own, and a function of several arguments
 * separates them with virgules.
 */

/** Literals, groupings and the separator between a function's arguments. */
const CONST_INT = key(-1, 0);
const CONST_DOUBLE = key(-1, 23);
const CONST_STRING = key(-1, 3);
const OPEN = key(-1, -1);
const CLOSE = key(-1, -2);
const VIRGULE = key(-1, -3);

/** The binary operators, and how tightly each binds. */
const PRECEDENCE: Record<string, number> = {
  [key(0, 2)]: 1, // +
  [key(0, 4)]: 1, // -
  [key(0, 6)]: 2, // *
  [key(0, 8)]: 2, // /
  [key(0, 10)]: 2, // %
};

/** Prefix functions, by how many arguments each takes. */
const FUNCTIONS: Record<string, number> = {
  [key(-1, 1)]: 1, // Random
  [key(-1, 4)]: 1, // Str$
  [key(-1, 10)]: 1, // Sin
  [key(-1, 11)]: 1, // Cos
  [key(-1, 19)]: 2, // Left$
  [key(-1, 22)]: 1, // Len
  [key(-1, 28)]: 1, // Int
  [key(-1, 29)]: 1, // Abs
  [key(-1, 46)]: 1, // LoopIndex
};

/** An extension's own expressions start here; everything below is the common set. */
const EXTENSION_EXPRESSION = 80;

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
  return new Parser(tokens, scene, pick).run();
}

type Value = number | string;

class Parser {
  private at = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly scene: FrameScene,
    private readonly pick: Resolve,
  ) {}

  /**
   * The whole stream as one value.
   *
   * A stream that ends mid-expression, or carries a token this runtime has no reading for,
   * stops the parse where it stands and yields what it has rather than throwing: one unknown
   * token in one parameter should cost that parameter, not the event around it.
   */
  run(): Value {
    return this.expression(0);
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private kindOf(token: Token | undefined): string {
    return token ? key(token.ObjectType, token.Num) : '';
  }

  /** Operands joined by operators, tightest-binding first. */
  private expression(minimum: number): Value {
    let left = this.operand();

    for (;;) {
      const kind = this.kindOf(this.peek());
      const precedence = PRECEDENCE[kind];
      if (precedence === undefined || precedence < minimum) return left;
      this.at++;
      const right = this.expression(precedence + 1);
      left = apply(kind, left, right);
    }
  }

  /** One operand: a literal, a group, a function call or a reading taken from the game. */
  private operand(): Value {
    const token = this.peek();
    if (!token) return 0;
    const kind = this.kindOf(token);

    if (kind === OPEN) {
      this.at++;
      const value = this.expression(0);
      this.closeGroup();
      return value;
    }

    if (FUNCTIONS[kind] !== undefined) {
      this.at++;
      return call(kind, this.arguments(), this.scene);
    }

    // Readings every object type shares are registered against the Active and reached from the
    // other types here, as the conditions and actions are: a scrolling background's alterable
    // value is read with the same expression an Active's is.
    if (token.ObjectType > 2 && token.Num < EXTENSION_EXPRESSION) {
      this.at++;
      return this.reading(key(2, token.Num), token);
    }

    // An extension's own expression, which takes arguments or does not depending on which one
    // it is: "read the array at X" is written like a function call, "the text in this box" is a
    // bare reading. The extension says which, so the parser asks before deciding.
    if (token.ObjectType >= 32) {
      const arity = this.scene.extensionExpressionArity(token.ObjectType, token.Num, token.ObjectInfo);
      if (arity !== null) {
        this.at++;
        const args = arity > 0 ? this.arguments() : [];
        return this.scene.extensionExpression(
          token.ObjectType, token.Num, token.ObjectInfo, token.Expression?.Value, args,
        );
      }
    }

    this.at++;
    return this.reading(kind, token);
  }

  /**
   * The arguments of something that opens its own group: they run to the matching
   * end-parenthesis, separated by virgules.
   */
  private arguments(): Value[] {
    const args: Value[] = [this.expression(0)];
    while (this.kindOf(this.peek()) === VIRGULE) {
      this.at++;
      args.push(this.expression(0));
    }
    this.closeGroup();
    return args;
  }

  /**
   * Steps past a group's end-parenthesis.
   *
   * Fusion always writes one, but a stream this runtime has stopped understanding part-way
   * through can leave the parser looking at something else; stepping only over the token that is
   * actually there keeps the rest of the stream aligned.
   */
  private closeGroup(): void {
    if (this.kindOf(this.peek()) === CLOSE) this.at++;
  }

  /** A literal, or something read out of the game as it stands. */
  private reading(kind: string, token: Token): Value {
    const raw = token.Expression?.Value;
    const instance = () => this.pick(token.ObjectInfo);

    switch (kind) {
      case CONST_INT:
        return typeof raw === 'number' ? raw : Number(raw) || 0;
      case CONST_DOUBLE:
        return typeof raw === 'number' ? raw : Number(raw) || 0;
      case CONST_STRING:
        return typeof raw === 'string' ? raw : String(raw ?? '');

      // Object readings.
      case key(2, 11):
        return instance()?.x ?? 0;
      case key(2, 1):
        return instance()?.y ?? 0;
      case key(2, 6):
        return instance()?.direction ?? 0;
      case key(2, 16): {
        const index = typeof raw === 'number' ? raw : 0;
        return instance()?.values[index] ?? 0;
      }
      case key(2, 14):
        return instance()?.animation ?? 0;
      case key(2, 15):
        return this.scene.instancesOf(token.ObjectInfo).length;
      case key(2, 7):
        return instance()?.bounds().left ?? 0;
      case key(2, 8):
        return instance()?.bounds().right ?? 0;
      case key(2, 9):
        return instance()?.bounds().top ?? 0;
      case key(2, 10):
        return instance()?.bounds().bottom ?? 0;
      // Counters keep their reading in alterable value 0.
      case key(7, 80):
        return instance()?.values[0] ?? 0;
      // A text object's current paragraph, as text.
      case key(3, 81):
        return instance()?.currentText() ?? '';

      // The mouse, in frame coordinates rather than window ones.
      case key(-6, 0):
        return this.scene.pointer().x;
      case key(-6, 1):
        return this.scene.pointer().y;

      // Where the visible window sits in the frame, which is what a parallax layer is placed by.
      case key(-3, 2):
        return this.scene.windowBounds().left;
      case key(-3, 4):
        return this.scene.windowBounds().top;
      case key(-3, 8):
        return this.scene.frame.index + 1;

      case key(-5, 0):
        return this.scene.instances.filter((i) => !i.destroyed).length;

      // Where the game was installed. A page has no such place, and the only use made of these
      // is to build a path for the save file, which the INI store keys on rather than opens.
      case key(-1, 6):
      case key(-1, 7):
        return '';

      default:
        return 0;
    }
  }
}

/** One binary operator applied. */
function apply(kind: string, left: Value, right: Value): Value {
  // Fusion's `+` is the string concatenation operator too, and which one it is depends on what
  // is on its left.
  if (kind === key(0, 2) && typeof left === 'string') return left + String(right);

  const a = Number(left) || 0;
  const b = Number(right) || 0;
  switch (kind) {
    case key(0, 2): return a + b;
    case key(0, 4): return a - b;
    case key(0, 6): return a * b;
    // Fusion divides and takes the remainder in integers, and dividing by zero yields zero
    // rather than an infinity that would then poison everything downstream of it.
    case key(0, 8): return b === 0 ? 0 : Math.trunc(a / b);
    case key(0, 10): return b === 0 ? 0 : Math.trunc(a % b);
    default: return a;
  }
}

/** Fusion's trigonometry is in degrees. */
const DEGREES = Math.PI / 180;

/** One function call applied. */
function call(kind: string, args: Value[], scene: FrameScene): Value {
  const n = (index: number) => Number(args[index]) || 0;
  const s = (index: number) => (typeof args[index] === 'string' ? (args[index] as string) : String(args[index] ?? ''));

  switch (kind) {
    // `Random(n)` is 0 to n-1, never n itself.
    case key(-1, 1): return Math.floor(Math.random() * Math.max(n(0), 1));
    case key(-1, 4): return String(n(0));
    case key(-1, 10): return Math.sin(n(0) * DEGREES);
    case key(-1, 11): return Math.cos(n(0) * DEGREES);
    case key(-1, 19): return s(0).slice(0, Math.max(n(1), 0));
    case key(-1, 22): return s(0).length;
    case key(-1, 28): return Math.trunc(n(0));
    case key(-1, 29): return Math.abs(n(0));
    // A fast loop's index, by the name the loop was started under.
    case key(-1, 46): return scene.loopIndex(s(0));
    default: return 0;
  }
}
