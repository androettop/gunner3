import type { AceDef, ObjectDef } from '../../data/types';
import type { FrameScene } from '../scene';
import { angleToDirection, type ActionFn, type ConditionFn, type Ctx } from './opcodes';
import { keysFor, num as numberOf, param, targets, text as textOf } from './interpreter';

/**
 * Extension objects, and the opcodes each one answers to.
 *
 * An extension's ACEs are not numbered in the engine's own namespace: they start at 80 and count
 * up from there, per extension. Which extension a number belongs to is decided by the object
 * type, and that type is only an index into the list of extensions the game was built with. It
 * is not stable between games: Gunner 3 gives the INI extension type 32 and the direction
 * calculator 33, while Gunner 4 gives the direction calculator 32, the edit box 33 and INI 39.
 * Keying handlers on the raw type would have Gunner 4's "point this at that" run Gunner 3's
 * "write a value into the save file".
 *
 * So the table is keyed on the extension itself, which each object carries: a four-character
 * identifier stamped into its data. Where that identifier does not name one extension on its
 * own the object's name settles it, which is what the ambiguous families below are for.
 */

/**
 * What an extension expression reads.
 *
 * Some are bare readings and some are written like function calls; `args` says which, so the
 * evaluator knows whether to go looking for arguments before it reads the value.
 */
export interface ExtensionExpression {
  readonly args?: number;
  read(
    scene: FrameScene,
    objectInfo: number,
    args: readonly (number | string)[],
  ): number | string;
}

export interface ExtensionSet {
  /** For the comment on an unimplemented opcode to say which extension it belonged to. */
  readonly name: string;
  readonly actions?: Readonly<Record<number, ActionFn>>;
  readonly conditions?: Readonly<Record<number, ConditionFn>>;
  readonly expressions?: Readonly<Record<number, ExtensionExpression>>;
}

/**
 * Several distinct extensions stamp themselves with the same identifier, so it alone cannot say
 * which one an object is. They are told apart by name; an object whose name is not listed falls
 * through to no extension at all rather than to the wrong one.
 */
const AMBIGUOUS: Record<string, Record<string, string>> = {
  '0MAS': {
    'Direction Calculator': 'directionCalculator',
    'DMC2 Object': 'dmc2',
    'File Encoder': 'fileEncoder',
    'Encryption Object': 'encryption',
  },
};

/** Identifiers that name one extension outright. */
const BY_IDENTIFIER: Record<string, string> = {
  '0INI': 'ini',
  ELIF: 'file',
  '0TSL': 'list',
  RYAL: 'layer',
  '0RRA': 'array',
  BSYS: 'scrollingBackground',
  LRTC: 'controlX',
  '00zE': 'edit',
  '2MAS': 'animationSpeed',
};

const EXTENSIONS: Record<string, ExtensionSet> = {
  /**
   * The INI extension, which is where save games live.
   *
   * Each object keeps its own file, group and item, so every opcode is addressed to the object
   * it belongs to. A level reads its progress through one and its weapons through another, and
   * a cursor shared between them would have each overwrite the other's item.
   */
  ini: {
    name: 'INI',
    actions: {
      80: (ctx, ace) => ctx.scene.ini.setGroup(ace.objectInfo, textOf(ctx, ace, 0)),
      81: (ctx, ace) => ctx.scene.ini.setItem(ace.objectInfo, textOf(ctx, ace, 0)),
      82: (ctx, ace) => ctx.scene.ini.write(ace.objectInfo, numberOf(ctx, ace, 0)),
      86: (ctx, ace) => ctx.scene.ini.setFile(ace.objectInfo, textOf(ctx, ace, 0)),
      // "Set the value of a named item", which names the item rather than using the standing
      // one. The cursor is left where it was pointed, as Fusion leaves it.
      87: (ctx, ace) => ctx.scene.ini.writeItem(
        ace.objectInfo, textOf(ctx, ace, 0), numberOf(ctx, ace, 1),
      ),
      89: (ctx, ace) => ctx.scene.ini.writeItem(
        ace.objectInfo, textOf(ctx, ace, 0), textOf(ctx, ace, 1),
      ),
    },
    expressions: {
      80: { read: (scene, objectInfo) => scene.ini.read(objectInfo) },
      81: { read: (scene, objectInfo) => scene.ini.readString(objectInfo) },
      // "The value of a named item", which reads without moving the object's own cursor.
      82: { args: 1, read: (scene, objectInfo, args) => scene.ini.readItem(objectInfo, String(args[0] ?? '')) },
    },
  },

  /**
   * The edit box, which this game uses as somewhere to keep a string rather than as something to
   * type into. Its boxes are named for what they hold and sit off the visible part of the frame,
   * so what matters is that a string written into one reads back out of it.
   */
  edit: {
    name: 'Edit',
    actions: {
      84: (ctx, ace) => { for (const i of targets(ctx, ace)) i.setText(textOf(ctx, ace, 0)); },
      92: (ctx, ace) => { for (const i of targets(ctx, ace)) i.visible = true; },
      93: (ctx, ace) => { for (const i of targets(ctx, ace)) i.visible = false; },
      // Enabling, focus and colour are about a box being typed into. Nothing is typed into
      // these, and a box that is only ever read has nothing to do about any of them.
      98: () => {},
      110: () => {},
      114: () => {},
    },
    expressions: {
      80: { read: (scene, objectInfo) => scene.instancesOf(objectInfo)[0]?.currentText() ?? '' },
    },
  },

  /** The array, which the game fills a slot at a time and reads back by index. */
  array: {
    name: 'Array',
    actions: {
      // "Write a value to X": the value comes first and the slot second.
      93: (ctx, ace) => ctx.scene.arrays.write(
        ace.objectInfo, numberOf(ctx, ace, 1), numberOf(ctx, ace, 0),
      ),
    },
    expressions: {
      85: { args: 1, read: (scene, objectInfo, args) => scene.arrays.read(objectInfo, Number(args[0]) || 0) },
    },
  },

  /**
   * The animation speed object, which sets the speed of an animation on an object named in the
   * action rather than on itself.
   */
  animationSpeed: {
    name: 'Change Animation Speed',
    actions: {
      80: (ctx, ace) => {
        const objectId = Number(param(ace, 0)?.data?.['ObjectInfo'] ?? -1);
        const speed = numberOf(ctx, ace, 1);
        for (const i of ctx.scene.instancesOf(objectId)) i.animationSpeedOverride = speed;
      },
    },
  },

  /**
   * The scrolling background, a backdrop the game slides about to make a parallax layer.
   *
   * The wrapping is the game's own: it works out where the layer should sit from the window's
   * position and the layer's height, modulo the height so it repeats, and hands the result here.
   * So what the extension is asked for is a position, and that is all this needs to do.
   */
  scrollingBackground: {
    name: 'Scrolling Background',
    actions: {
      81: (ctx, ace) => {
        const x = numberOf(ctx, ace, 0);
        const y = numberOf(ctx, ace, 1);
        for (const i of targets(ctx, ace)) { i.x = x; i.y = y; }
      },
    },
  },

  /**
   * The control object, which is how this game reads the keyboard.
   *
   * It does not name keys itself: the game keeps the player's bindings in its own INI file as
   * Windows virtual key codes, loads them into an object's alterable values and hands one of
   * those numbers to each of these conditions. So "is the player holding right" arrives here as
   * "is key 39 down", and the codes go through the same table the engine's own key conditions
   * use. A binding the player has cleared is stored as 1000, which matches no key.
   */
  controlX: {
    name: 'Control X',
    conditions: {
      // Upon pressing, while held, and while not held.
      [-87]: (ctx, ace) => ctx.scene.wasPressed(keysFor(numberOf(ctx, ace, 0))),
      [-88]: (ctx, ace) => held(ctx, numberOf(ctx, ace, 0)),
      [-89]: (ctx, ace) => !held(ctx, numberOf(ctx, ace, 0)),
      // "Any key", which the options screen watches while it waits for one to bind.
      [-90]: (ctx) => ctx.scene.anyKeyPressed(),
    },
    expressions: {
      // The key just pressed, as the code the game stores its bindings as.
      81: { read: (scene) => scene.pressedKeyCodes()[0] ?? 0 },
    },
  },

  /**
   * The direction calculator points one object at a place named by a position parameter, which
   * is the same job as the engine's own "look at".
   */
  directionCalculator: {
    name: 'Direction Calculator',
    actions: {
      82: (ctx, ace) => lookAt(ctx, ace),
    },
  },
};

/** Whether a key, named by the code the game stores, is being held down. */
function held(ctx: Ctx, code: number): boolean {
  return keysFor(code).some((key) => ctx.engine.input.keyboard.isHeld(key));
}

/** The extension an object belongs to, or nothing where this runtime does not know it. */
export function extensionOf(def: ObjectDef | undefined): ExtensionSet | undefined {
  const identifier = identifierOf(def);
  if (!identifier || !def) return undefined;
  const ambiguous = AMBIGUOUS[identifier];
  const name = ambiguous ? ambiguous[def.name] : BY_IDENTIFIER[identifier];
  return name ? EXTENSIONS[name] : undefined;
}

/**
 * "Point the object named first at the place named second."
 *
 * The position is read relative to its parent object, as any position parameter is, and every
 * instance of the object being aimed is turned towards the one point.
 */
function lookAt(ctx: Ctx, ace: AceDef): void {
  const targetId = Number(param(ace, 0)?.data?.['ObjectInfo'] ?? -1);
  const at = param(ace, 1)?.data;
  const parentId = Number(at?.['ObjectInfoParent'] ?? -1);
  const parent = ctx.scene.instancesOf(parentId)[0];
  if (!parent) return;
  const x = parent.x + Number(at?.['X'] ?? 0);
  const y = parent.y + Number(at?.['Y'] ?? 0);
  for (const i of ctx.scene.instancesOf(targetId)) {
    i.setDirection(angleToDirection(x - i.x, y - i.y));
  }
}

/** The four-character stamp an extension object carries, where it has one. */
export function identifierOf(def: ObjectDef | undefined): string | undefined {
  const detail = def?.detail as { identifier?: string } | null | undefined;
  return typeof detail?.identifier === 'string' ? detail.identifier : undefined;
}
