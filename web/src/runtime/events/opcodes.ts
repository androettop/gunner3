import { Engine } from 'excalibur';
import type { AceDef, EventDef } from '../../data/types';
import { DIRECTION_COUNT, type FusionInstance } from '../instance';
import { bounce, shotState } from '../movement';
import type { FrameScene } from '../scene';
import type { EventInterpreter } from './interpreter';
import { instancesFor, keysFor, num, param, resolver, select, targets, text } from './interpreter';
import { evaluate } from './expression';

export interface Ctx {
  scene: FrameScene;
  engine: Engine;
  delta: number;
  /** Instances narrowed by conditions, keyed by object id; actions apply to these. */
  selection: Map<number, FusionInstance[]>;
  /**
   * Set by a condition that has already dealt with its own negation by choosing which instances
   * to keep. The interpreter must not then invert the result a second time.
   */
  negationApplied: boolean;
  startOfFrame: boolean;
  /** Identifies the condition being evaluated, for per-condition edge tracking. */
  conditionKey: string;
  interpreter: EventInterpreter;
  event: EventDef;
  /** The fast loop being run, or null in the ordinary once-a-tick pass. */
  loop: string | null;
}

export type ConditionFn = (ctx: Ctx, ace: AceDef) => boolean;
export type ActionFn = (ctx: Ctx, ace: AceDef) => void;

/** Fusion comparison operators, as stored in a ParameterExpressions chunk. */
function compare(op: number, left: number, right: number): boolean {
  switch (op) {
    case 0: return left === right;
    case 1: return left !== right;
    case 2: return left <= right;
    case 3: return left < right;
    case 4: return left >= right;
    case 5: return left > right;
    default: return left === right;
  }
}

function comparison(ace: AceDef, index: number): number {
  return Number(param(ace, index)?.data?.['Comparison'] ?? 0);
}

/**
 * The object a system-object condition acts on.
 *
 * For conditions owned by a system object (-1, -3, -4, -6, -7) the ace's own objectInfo is
 * always 0, which is itself a valid object id. The object being tested is carried in a
 * ParameterObject instead, so taking objectInfo at face value makes every mouse condition ask
 * about whichever object happens to be numbered zero.
 */
function subjectObject(ace: AceDef): number | null {
  const p = ace.parameters.find((x) => x.type === 'ParameterObject');
  const id = p?.data?.['ObjectInfo'];
  if (typeof id === 'number') return id;
  return ace.objectType < 0 ? null : ace.objectInfo;
}

/**
 * Run an action over the instances it applies to, one at a time.
 *
 * While each one is handled it becomes the event's whole selection for that object, so an
 * expression naming the object resolves to it. That is what makes "set Y to Y(self) + 1" move
 * each instance from where it is: evaluating the expression once for the group instead snaps
 * every one of them onto the first instance's position.
 *
 * The rest of the event's selection is paired off
 * against it by position too: the same rule "Set position at ... from X" uses, wrapping round
 * when one side has more instances than the other.
 *
 * That pairing is what makes an expression inside the action read the right object. A level parks
 * each enemy's arm on its enemy and copies that enemy's facing with "Set direction to
 * Dir(Enemy)": resolving the expression against the whole selection instead hands every arm the
 * first enemy's facing, so arms on enemies looking right were drawn aiming left: the weapon
 * pointing at the player while the enemy holding it faced away.
 */
function forEach(ctx: Ctx, ace: AceDef, apply: (instance: FusionInstance) => void): void {
  const all = targets(ctx, ace);
  const others = [...ctx.selection].filter(([id]) => id !== ace.objectInfo);
  all.forEach((instance, index) => {
    select(ctx, ace.objectInfo, [instance]);
    for (const [id, instances] of others)
      if (instances.length) select(ctx, id, [instances[index % instances.length]]);
    apply(instance);
  });
  select(ctx, ace.objectInfo, all);
  for (const [id, instances] of others) select(ctx, id, instances);
}

/**
 * Narrow an object's selection to the instances a condition holds for, and report whether any
 * are left.
 *
 * A negated condition is not the event's result inverted: it keeps the instances the condition
 * is false for. "Enemy arm is NOT playing its firing animation" has to leave behind the arms
 * that are free to fire: inverting at the end instead lets the whole squad fire whenever one of
 * them is idle, and stops all of them whenever one is busy.
 *
 * Each instance is the whole selection while it is examined, so an expression inside the
 * condition reads that instance's own values.
 */
function pickAmong(
  ctx: Ctx,
  ace: AceDef,
  objectId: number,
  all: FusionInstance[],
  predicate: (i: FusionInstance) => boolean,
): boolean {
  const kept: FusionInstance[] = [];
  for (const instance of all) {
    select(ctx, objectId, [instance]);
    if (predicate(instance) !== ace.negated) kept.push(instance);
  }
  select(ctx, objectId, kept);
  ctx.negationApplied = true;
  return kept.length > 0;
}

function pick(ctx: Ctx, ace: AceDef, predicate: (i: FusionInstance) => boolean): boolean {
  return pickAmong(ctx, ace, ace.objectInfo, targets(ctx, ace), predicate);
}

function pickOn(
  ctx: Ctx,
  ace: AceDef,
  objectId: number | null,
  predicate: (i: FusionInstance) => boolean,
): boolean {
  if (objectId === null) return false;
  return pickAmong(ctx, ace, objectId, instancesFor(ctx, objectId), predicate);
}

/** The object a position/collision parameter points at. */
function paramObject(ace: AceDef, index: number): number | null {
  const data = param(ace, index)?.data;
  if (!data) return null;
  const id = data['ObjectInfo'] ?? data['ObjectInfoParent'];
  return typeof id === 'number' ? id : null;
}

// ---------------------------------------------------------------- conditions

export const CONDITIONS: Record<string, ConditionFn> = {
  // System
  '-1:-1': () => true,
  '-1:-6': (ctx) => ctx.interpreter.triggerOnce(ctx.event.index),
  // "Only one action when event loops" is bookkeeping the interpreter does once every other
  // condition has been decided, so as a condition it simply passes.
  '-1:-7': () => true,
  '-3:-1': (ctx) => ctx.startOfFrame,
  // Group start/end markers. The grouping itself is handled by the interpreter; the marker
  // event carries only a no-op action, so letting it pass costs nothing.
  '-1:-10': () => true,
  '-1:-11': () => true,
  '-4:-4': (ctx, ace) => {
    const delay = Number(param(ace, 0)?.data?.['Delay'] ?? 100);
    return ctx.interpreter.every(`${ctx.event.index}:${ace.num}`, delay, ctx.delta);
  },
  // "Timer is greater than": the comparison lives in the opcode itself, not in the parameter.
  // A timer parameter carries a Comparison field, but it holds something else entirely: the
  // game's three timer conditions give it 12, 32 and 34, none of which is an operator, and
  // reading it as one turns "past two seconds" into "at exactly two seconds".
  '-4:-1': (ctx, ace) => ctx.scene.elapsed * 1000 > Number(param(ace, 0)?.data?.['Timer'] ?? 0),

  // Input
  // "Upon pressing" reads the presses the scene latched, not the engine's per-frame state: a
  // press that lands in a rendered frame with no logic tick in it is gone before any event runs.
  '-6:-1': (ctx, ace) => ctx.scene.wasPressed(keysFor(num(ctx, ace, 0))),
  '-6:-2': (ctx, ace) => keysFor(num(ctx, ace, 0)).some((k) => ctx.engine.input.keyboard.isHeld(k)),
  '-6:-4': (ctx, ace) => pickOn(ctx, ace, subjectObject(ace), (i) => under(ctx, i)),
  '-6:-7': (ctx, ace) => ctx.scene.wasClicked() && pickOn(ctx, ace, subjectObject(ace), (i) => under(ctx, i)),

  // Object state
  '2:-1': (ctx, ace) => pick(ctx, ace, (i) => compare(comparison(ace, 0), i.animationFrame, num(ctx, ace, 0))),
  '2:-2': (ctx, ace) => pick(ctx, ace, (i) => i.finishedAnimation === num(ctx, ace, 0)),
  '2:-3': (ctx, ace) => pick(ctx, ace, (i) => i.animation === num(ctx, ace, 0)),
  '2:-8': (ctx, ace) => pick(ctx, ace, (i) => (num(ctx, ace, 0) & (1 << i.direction)) !== 0),
  '2:-9': (ctx, ace) => pick(ctx, ace, (i) => inPlayArea(ctx.scene, i)),
  '2:-16': (ctx, ace) => pick(ctx, ace, (i) => compare(comparison(ace, 0), i.y, num(ctx, ace, 0))),
  '2:-17': (ctx, ace) => pick(ctx, ace, (i) => compare(comparison(ace, 0), i.x, num(ctx, ace, 0))),
  '2:-24': (ctx, ace) => pick(ctx, ace, (i) => (i.flags & (1 << num(ctx, ace, 0))) === 0),
  '2:-25': (ctx, ace) => pick(ctx, ace, (i) => (i.flags & (1 << num(ctx, ace, 0))) !== 0),
  '2:-27': (ctx, ace) => {
    const index = num(ctx, ace, 0);
    return pick(ctx, ace, (i) => compare(comparison(ace, 1), i.values[index] ?? 0, num(ctx, ace, 1)));
  },
  '2:-29': (ctx, ace) => pick(ctx, ace, (i) => i.visible),
  '2:-32': (ctx, ace) => compare(comparison(ace, 0), ctx.scene.instancesOf(ace.objectInfo).length, num(ctx, ace, 0)),
  '2:-33': (ctx, ace) => ctx.scene.instancesOf(ace.objectInfo).length === 0,
  // The answer survives one pass of the event loop, which is when the game reacts to it.
  '4:-83': (ctx, ace) => ctx.scene.answers.get(ace.objectInfo) === num(ctx, ace, 0),
  '2:-21': (ctx, ace) => pick(ctx, ace, (i) => i.movement?.finished === true),
  '2:-34': (ctx, ace) => {
    const all = ctx.scene.instancesOf(ace.objectInfo);
    if (!all.length) return false;
    select(ctx, ace.objectInfo, [all[Math.floor(Math.random() * all.length)]]);
    return true;
  },

  // Collision
  // "is overlapping" is continuous; "collision between" is triggered, so it only reports pairs
  // that were not already touching on the previous evaluation.
  '2:-4': (ctx, ace) => overlap(ctx, ace, ace.objectInfo, paramObject(ace, 0)),
  '2:-14': (ctx, ace) => overlap(ctx, ace, ace.objectInfo, paramObject(ace, 0), ctx.conditionKey),
  '2:-22': (ctx, ace) => {
    const distance = num(ctx, ace, 0);
    return pick(ctx, ace, (i) => nearEdge(ctx.scene, i, distance));
  },
  // Both read the frame's obstacle mask; Fusion draws no distinction between an obstacle
  // backdrop placed in the editor and one pasted at runtime. -13 is the triggered form, firing
  // as an object meets the background, while -23 stays true for as long as it overlaps.
  '2:-13': (ctx, ace) => {
    // An object meets the background either by overlapping it or by having its movement stopped
    // by it: a movement halts flush against the scenery, so the overlap alone never happens.
    const touching = targets(ctx, ace)
      .filter((i) => touchesObstacle(ctx, i) || (i.hitBackground && !i.destroying && !i.destroyed));
    const fresh = ctx.interpreter.freshPairs(ctx.conditionKey, new Set(touching.map((i) => String(i.id))));
    const started = touching.filter((i) => fresh.has(String(i.id)));
    if (!started.length) return false;
    select(ctx, ace.objectInfo, started);
    return true;
  },
  '2:-23': (ctx, ace) => pick(ctx, ace, (i) => touchesObstacle(ctx, i)),

  // Counters keep their reading in alterable value 0.
  '7:-81': (ctx, ace) => pick(ctx, ace, (i) => compare(comparison(ace, 0), i.values[0] ?? 0, num(ctx, ace, 0))),

  // "Never": the event is switched off in the editor and never fires.
  '-1:-2': () => false,

  // "Compare two general values", the general-purpose test: both sides are expressions and the
  // operator travels with the right-hand one, as it does for the alterable-value comparison.
  // The left parameter carries a comparison field too, but it is always zero and reading the
  // operator from it turns every one of these into "equals": a level asks whether a key binding
  // is below the number that stands for "unbound", and read as equality that is never true, so
  // nothing the player pressed reached the game.
  '-1:-3': (ctx, ace) => compare(comparison(ace, 1), num(ctx, ace, 0), num(ctx, ace, 1)),

  // "On loop": true only while the named fast loop is the one being run, which is what makes an
  // event belong to a loop rather than to the tick.
  '-1:-16': (ctx, ace) => ctx.loop !== null && ctx.loop === text(ctx, ace, 0),

  // The remaining two timer comparisons. As with "is greater than", the operator is in the
  // opcode rather than in the parameter, which carries something else in its Comparison field.
  '-4:-2': (ctx, ace) => ctx.scene.elapsed * 1000 < Number(param(ace, 0)?.data?.['Timer'] ?? 0),
  '-4:-3': (ctx, ace) => {
    // "Equals" cannot mean one exact millisecond, which a tick would step straight over; it is
    // true for the tick the timer passes the mark on.
    const mark = Number(param(ace, 0)?.data?.['Timer'] ?? 0) / 1000;
    return ctx.scene.elapsed >= mark && ctx.scene.elapsed - ctx.delta < mark;
  },

  // End of frame and end of application: neither happens on its own, so both stay false until
  // something in the game asks for it.
  '-3:-2': () => false,
  '-3:-4': () => false,

  // "Is the position an obstacle": a point in the frame, tested against the obstacle mask.
  '-3:-5': (ctx, ace) => ctx.scene.obstacles.test(num(ctx, ace, 0), num(ctx, ace, 1)),

  // The mouse, as a click rather than as a press on an object.
  '-6:-5': (ctx) => ctx.scene.wasClicked(),

  // More object state, in the same shape as the readings already above.
  '2:-12': (ctx, ace) => {
    const outside = targets(ctx, ace).filter((i) => !inPlayArea(ctx.scene, i));
    const fresh = ctx.interpreter.freshPairs(ctx.conditionKey, new Set(outside.map((i) => String(i.id))));
    const leaving = outside.filter((i) => fresh.has(String(i.id)));
    if (!leaving.length) return false;
    select(ctx, ace.objectInfo, leaving);
    return true;
  },
  '2:-15': (ctx, ace) => pick(ctx, ace, (i) => compare(comparison(ace, 0), i.speed, num(ctx, ace, 0))),
  '2:-28': (ctx, ace) => pick(ctx, ace, (i) => !i.visible),
};

// ---------------------------------------------------------------- actions

export const ACTIONS: Record<string, ActionFn> = {
  // Position
  // "Set position at ... from X" pairs off the two objects by position in their selections,
  // wrapping round if there are more of one than the other. Taking a single point for the whole
  // group instead piles every instance onto the first, which is how a level's enemies lose
  // their weapons: each arm is parked on its own enemy by this action, and they all ended up
  // stacked on one.
  '2:1': (ctx, ace) => {
    const origins = positionOrigins(ctx, ace, 0);
    if (!origins.length) return;
    targets(ctx, ace).forEach((instance, index) => {
      const origin = origins[index % origins.length];
      instance.x = origin.x;
      instance.y = origin.y;
    });
  },
  '2:2': (ctx, ace) => forEach(ctx, ace, (i) => { i.x = num(ctx, ace, 0); }),
  '2:3': (ctx, ace) => forEach(ctx, ace, (i) => { i.y = num(ctx, ace, 0); }),
  '2:4': (ctx, ace) => { for (const i of targets(ctx, ace)) i.moving = false; },
  '2:5': (ctx, ace) => { for (const i of targets(ctx, ace)) i.moving = true; },
  '2:14': (ctx, ace) => {
    if (!positionParent(ctx, ace, 0)) return;
    const at = positionOrigin(ctx, ace, 0);
    for (const i of targets(ctx, ace)) i.setDirection(angleToDirection(at.x - i.x, at.y - i.y));
  },

  // Appearance
  '2:17': (ctx, ace) => forEach(ctx, ace, (i) => i.setAnimation(num(ctx, ace, 0))),
  '2:23': (ctx, ace) => forEach(ctx, ace, (i) => i.setDirection(directionFrom(ctx, ace, 0))),
  // Destroying is not always immediate: an object with a disappearing animation plays it out
  // first, which is what makes a shot spark against a wall and a barrel throw off debris as it
  // explodes. Either way the object stays in this event's selection for the actions that follow.
  '2:24': (ctx, ace) => destroy(ctx, ace),
  '2:26': (ctx, ace) => { for (const i of targets(ctx, ace)) i.visible = false; },
  '2:27': (ctx, ace) => { for (const i of targets(ctx, ace)) i.visible = true; },
  '2:81': (ctx, ace) => { for (const i of targets(ctx, ace)) ctx.scene.bringToFront(i); },
  // NebulaFD has no entry for this opcode, but the MMF2 runtime's own action table names Active
  // 81 and 82 BringActiveToFront and BringActiveToBack.
  '2:82': (ctx, ace) => { for (const i of targets(ctx, ace)) ctx.scene.bringToBack(i); },
  '2:80': (ctx, ace) => { for (const i of targets(ctx, ace)) ctx.scene.paste(i); },

  // Alterable values and flags
  '2:31': (ctx, ace) => forEach(ctx, ace, (i) => { i.values[num(ctx, ace, 0)] = num(ctx, ace, 1); }),
  '2:32': (ctx, ace) => forEach(ctx, ace, (i) => {
    const k = num(ctx, ace, 0);
    i.values[k] = (i.values[k] ?? 0) + num(ctx, ace, 1);
  }),
  '2:33': (ctx, ace) => forEach(ctx, ace, (i) => {
    const k = num(ctx, ace, 0);
    i.values[k] = (i.values[k] ?? 0) - num(ctx, ace, 1);
  }),
  '2:35': (ctx, ace) => forEach(ctx, ace, (i) => { i.flags |= 1 << num(ctx, ace, 0); }),
  '2:36': (ctx, ace) => forEach(ctx, ace, (i) => { i.flags &= ~(1 << num(ctx, ace, 0)); }),
  '2:37': (ctx, ace) => forEach(ctx, ace, (i) => { i.flags ^= 1 << num(ctx, ace, 0); }),

  // Counters
  '7:80': (ctx, ace) => forEach(ctx, ace, (i) => i.setCounter(num(ctx, ace, 0))),
  '7:81': (ctx, ace) => forEach(ctx, ace, (i) => i.setCounter((i.values[0] ?? 0) + num(ctx, ace, 0))),
  '7:82': (ctx, ace) => forEach(ctx, ace, (i) => i.setCounter((i.values[0] ?? 0) - num(ctx, ace, 0))),

  // Creation and shooting
  '-5:0': (ctx, ace) => {
    const data = placement(ace, 0);
    const created = typeof data?.['ObjectInfo'] === 'number' ? data['ObjectInfo'] : null;
    if (data === null || created === null) return;

    // One copy per instance of the object it is created from. Nothing to anchor to means that
    // object is gone, and Fusion creates nothing rather than dropping a copy at the frame origin.
    const born: FusionInstance[] = [];
    for (const origin of positionOrigins(ctx, ace, 0)) {
      const instance = ctx.scene.spawn(created, origin.x, origin.y);
      if (instance) born.push(instance);
    }
    if (born.length) selectCreated(ctx, ace, created, born);
  },
  '2:29': (ctx, ace) => launch(ctx, ace),
  '2:30': (ctx, ace) => launchToward(ctx, ace),

  // Bounce off whatever the object just hit, which is not the same as turning around: an object
  // that grazed a floor should skim along it, not go back the way it came.
  '2:9': (ctx, ace) => {
    for (const i of targets(ctx, ace)) bounce(i, ctx.scene);
  },

  // Sound
  '-2:0': (ctx, ace) => ctx.scene.audio?.playSample(sampleHandle(ace)),
  '-2:2': (ctx, ace) => ctx.scene.audio?.playMusic(sampleHandle(ace), false),
  '-2:5': (ctx, ace) => ctx.scene.audio?.playMusic(sampleHandle(ace), num(ctx, ace, 1) > 1),
  '-2:3': (ctx) => ctx.scene.audio?.stopMusic(),

  // Storyboard
  /**
   * "Jump to frame", which names the frame it wants in one of two ways.
   *
   * Picked from the editor's list, the frame arrives as a plain number that is the frame's
   * handle, and the manifest's handle table says which frame that is. Worked out at runtime it
   * arrives as an expression instead, and is then the frame's ordinal, counting from one.
   *
   * The two are not interchangeable, and Gunner 4 leans on the second: every screen sets a
   * counter to the number of the frame it wants and jumps to a dispatcher frame that reads the
   * counter and jumps on. Reading that counter as a handle sends the whole game sideways, since
   * the two orderings are a shuffle of each other: the intro asks for frame 7, its title
   * screen, and as a handle 7 is the save screen, so the game opened on a save it had not made.
   */
  '-3:2': (ctx, ace) => {
    const parameter = param(ace, 0);
    const value = num(ctx, ace, 0);
    const index = parameter?.type === 'ParameterExpressions'
      ? value - 1
      : ctx.scene.data.frameForHandle(value);
    ctx.scene.onJumpToFrame?.(index);
  },
  '-3:4': (ctx) => { ctx.scene.audio?.stopMusic(); ctx.scene.onEndApplication?.(); },
  '-7:2': (ctx) => { ctx.scene.controlIgnored = true; },
  '-7:3': (ctx) => { ctx.scene.controlIgnored = false; },

  // Text objects display one of their stored paragraphs.
  '3:84': (ctx, ace) => forEach(ctx, ace, (i) => i.setParagraph(num(ctx, ace, 0))),

  // "Ask question" carries the point the panel is drawn at, as an ordinary position parameter.
  '4:80': (ctx, ace) => {
    const at = positionOrigin(ctx, ace, 0);
    ctx.scene.ask(ace.objectInfo, at.x, at.y);
  },

  // The group marker event's action carries no payload.
  '-1:0': () => {},

  // Fast loops. "Start loop" runs it there and then; the interpreter owns the iteration.
  '-1:14': (ctx, ace) => ctx.interpreter.runLoop(text(ctx, ace, 0), num(ctx, ace, 1)),
  '-1:15': (ctx, ace) => ctx.interpreter.stopLoop(text(ctx, ace, 0)),

  // Scrolling, one axis at a time.
  '-3:8': (ctx, ace) => ctx.scene.centreOnX(num(ctx, ace, 0)),
  '-3:9': (ctx, ace) => ctx.scene.centreOnY(num(ctx, ace, 0)),

  // The window, which the page's own controls otherwise handle. Nothing here needs to be told
  // to the game, so both are left to the shell rather than fought over with it.
  '-3:14': () => {},
  '-3:15': () => {},

  // Every sound at once, as opposed to the music.
  '-2:1': (ctx) => ctx.scene.audio?.stopAll(),

  // The cursor belongs to the page rather than to the frame.
  '-6:0': (ctx) => ctx.scene.setCursorVisible(false),
  '-6:1': (ctx) => ctx.scene.setCursorVisible(true),

  // Movement and animation, in the same shape as the actions already above.
  '2:6': (ctx, ace) => forEach(ctx, ace, (i) => { i.speed = num(ctx, ace, 0); }),
  '2:15': (ctx, ace) => { for (const i of targets(ctx, ace)) i.animationPaused = true; },
  '2:16': (ctx, ace) => { for (const i of targets(ctx, ace)) i.animationPaused = false; },
  // "Force frame" pins the animation to one frame until it is restored.
  '2:40': (ctx, ace) => forEach(ctx, ace, (i) => i.forceAnimationFrame(num(ctx, ace, 0))),
  '2:41': (ctx, ace) => { for (const i of targets(ctx, ace)) i.forceAnimationFrame(null); },
  // Semi-transparency runs 0 (solid) to 128 (invisible), the other way round from an alpha.
  '2:39': (ctx, ace) => forEach(ctx, ace, (i) => {
    i.opacity = 1 - Math.min(Math.max(num(ctx, ace, 0), 0), 128) / 128;
  }),

  /**
   * "Spread a value": walks the selected instances handing each the next number in turn, which
   * is how a level gives every one of a group its own index to be addressed by afterwards.
   */
  '2:34': (ctx, ace) => {
    const index = num(ctx, ace, 0);
    let value = num(ctx, ace, 1);
    for (const i of [...targets(ctx, ace)].reverse()) i.values[index] = value++;
  },

  // A text object's string, set outright rather than chosen from its stored paragraphs.
  '3:88': (ctx, ace) => forEach(ctx, ace, (i) => i.setText(text(ctx, ace, 0))),
  // The colour it is drawn in, which Fusion stores as a packed BGR number.
  '3:83': (ctx, ace) => forEach(ctx, ace, (i) => i.setTextColor(colourOf(num(ctx, ace, 0)))),

  '-3:7': (ctx, ace) => {
    // With no parent object there is nothing to centre on; Fusion leaves the view alone rather
    // than snapping it to the frame origin.
    if (!positionParent(ctx, ace, 0)) return;
    const origin = positionOrigin(ctx, ace, 0);
    ctx.scene.centreOn(origin.x, origin.y);
  },
};

// ---------------------------------------------------------------- helpers

/**
 * A colour parameter as CSS.
 *
 * Fusion packs a colour into one number with blue in the high byte, which is the reverse of the
 * order the same three bytes are written in as hex.
 */
function colourOf(packed: number): string {
  const value = packed >>> 0;
  const red = value & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = (value >> 16) & 0xff;
  return `#${[red, green, blue].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Shared body of the destroy actions, which differ only in which object type they arrive on. */
function destroy(ctx: Ctx, ace: AceDef): void {
  for (const i of targets(ctx, ace)) {
    i.beginDestroy();
    i.destroyedByEvent = ctx.event.index;
    ctx.scene.noteDestroyed(i, ctx.event);
  }
}


function overlap(
  ctx: Ctx,
  ace: AceDef,
  aId: number,
  bId: number | null,
  triggerKey?: string,
): boolean {
  if (bId === null) return false;
  const as = instancesFor(ctx, aId);
  const bs = instancesFor(ctx, bId);

  const touching: [FusionInstance, FusionInstance][] = [];
  const pairKeys = new Set<string>();
  for (const a of as)
    for (const b of bs)
      if (a !== b && a.overlaps(b)) {
        touching.push([a, b]);
        pairKeys.add(`${a.id}:${b.id}`);
      }

  let considered = touching;
  if (triggerKey !== undefined) {
    const fresh = ctx.interpreter.freshPairs(triggerKey, pairKeys);
    considered = touching.filter(([a, b]) => fresh.has(`${a.id}:${b.id}`));
  }
  const hitA: FusionInstance[] = [];
  const hitB: FusionInstance[] = [];
  for (const [a, b] of considered) {
    if (!hitA.includes(a)) hitA.push(a);
    if (!hitB.includes(b)) hitB.push(b);
  }

  // "Is not overlapping" asks whether nothing is touching, and narrows nothing: there is no set
  // of instances for a collision that did not happen. The empty case is the point: a level
  // gates its enemies on not being frozen, and with no ice anywhere in the frame that has to
  // read as true, not as "no instances, so no".
  if (ace.negated) {
    ctx.negationApplied = true;
    return considered.length === 0;
  }

  if (!considered.length) return false;
  select(ctx, aId, hitA);
  select(ctx, bId, hitB);
  return true;
}

/**
 * Position-bearing parameters.
 *
 * "Create object" carries its placement inside a ParameterCreate rather than in a separate
 * position parameter: same fields, different flag name. Reading only ParameterPosition left
 * every created object at the frame origin, which is 1313 of this game's actions.
 */
function placement(ace: AceDef, index: number): Record<string, any> | null {
  const data = param(ace, index)?.data;
  if (!data) return null;
  return 'PositionFlags' in data || 'CreateFlags' in data || 'ShootFlags' in data ? data : null;
}

function placementFlags(data: Record<string, any>): number {
  return Number(
    data['PositionFlags']?.['Value'] ?? data['CreateFlags']?.['Value'] ?? data['ShootFlags']?.['Value'] ?? 0,
  );
}

/**
 * Resolves a direction parameter.
 *
 * Fusion writes a direction two different ways. A literal is a 32-bit mask of the directions the
 * object is allowed to face, and the runtime picks one of the set bits at random: that is what
 * the editor shows as a row of dots. An expression instead yields the direction index itself.
 * Treating an expression as a mask turns a health reading of 10 into "bit 1 or bit 3", which is
 * how a full health bar came to render as nearly empty.
 */
function directionFrom(ctx: Ctx, ace: AceDef, index: number): number {
  const parameter = param(ace, index);
  if (parameter?.type === 'ParameterExpressions') {
    const value = evaluate(ctx.scene, parameter, resolver(ctx));
    return ((value % DIRECTION_COUNT) + DIRECTION_COUNT) % DIRECTION_COUNT;
  }
  return maskToDirection(Number(parameter?.data?.['Value'] ?? 0));
}

/**
 * Newly created objects become the event's selection for that object, so the actions that follow
 * address the copy just made rather than every one on screen, which is how "create a corpse and
 * point it the way the enemy was facing" turns only the new corpse.
 *
 * Two cases leave the selection alone: an object created relative to itself, which is narrowing
 * an existing selection rather than replacing it, and an object an earlier action in the same
 * event already addressed.
 */
function selectCreated(ctx: Ctx, ace: AceDef, objectId: number, born: FusionInstance[]): void {
  const index = ctx.event.actions.indexOf(ace);
  for (let i = 0; i < index; i++) {
    if (ctx.event.actions[i].objectInfo === objectId) return;
  }

  const parentId = Number(placement(ace, 0)?.['ObjectInfoParent'] ?? 0xffff);
  const previous = parentId === objectId ? (ctx.selection.get(objectId) ?? []) : [];
  select(ctx, objectId, [...previous, ...born]);
}

/** The instances a position parameter is relative to; empty when it names an absolute point. */
function positionParents(ctx: Ctx, ace: AceDef, index: number): FusionInstance[] {
  const parentId = Number(placement(ace, index)?.['ObjectInfoParent'] ?? -1);
  // 0xFFFF is Fusion's "no parent" marker.
  if (parentId < 0 || parentId === 0xffff) return [];
  return instancesFor(ctx, parentId);
}

/** The instance a position parameter is relative to, or null when it names an absolute point. */
function positionParent(ctx: Ctx, ace: AceDef, index: number): FusionInstance | null {
  return positionParents(ctx, ace, index)[0] ?? null;
}

/**
 * Resolves a position parameter to a point in frame coordinates.
 *
 * Bit 1 of the flags selects the parent's action point over its hotspot; every parented
 * position in this game sets it.
 */
function positionOrigin(ctx: Ctx, ace: AceDef, index: number): { x: number; y: number } {
  return positionOrigins(ctx, ace, index)[0] ?? { x: 0, y: 0 };
}

/**
 * Every point a position parameter resolves to: one per instance of its parent object, since
 * an action anchored to an object repeats for each instance the event selected.
 */
function positionOrigins(ctx: Ctx, ace: AceDef, index: number): { x: number; y: number }[] {
  const data = placement(ace, index);
  const dx = Number(data?.['X'] ?? 0);
  const dy = Number(data?.['Y'] ?? 0);
  const parents = positionParents(ctx, ace, index);
  if (!parents.length) {
    // A parent that named an object with no instances left resolves to nothing at all, rather
    // than falling back to the frame origin.
    const parentId = Number(data?.['ObjectInfoParent'] ?? 0xffff);
    if (parentId !== 0xffff && parentId >= 0) return [];
    return [{ x: dx, y: dy }];
  }

  const fromActionPoint = (placementFlags(data!) & 2) !== 0;
  return parents.map((parent) => {
    const base = fromActionPoint ? parent.actionPoint() : { x: parent.x, y: parent.y };
    return { x: base.x + dx, y: base.y + dy };
  });
}

/** Sound and music actions carry a ParameterSample naming a bank entry by handle. */
function sampleHandle(ace: AceDef): number {
  return Number(param(ace, 0)?.data?.['Handle'] ?? -1);
}

/** True when the mouse pointer is inside the instance's box. */
function under(ctx: Ctx, i: FusionInstance): boolean {
  const pointer = ctx.engine.input.pointers.primary.lastWorldPos;
  if (!pointer) return false;
  const b = i.bounds();
  return pointer.x >= b.left && pointer.x <= b.right && pointer.y >= b.top && pointer.y <= b.bottom;
}

/** True where any of the instance's box overlaps a solid background pixel. */
export function touchesObstacle(ctx: Ctx, i: FusionInstance): boolean {
  // As with object collisions, something already on its way out no longer registers one.
  if (i.destroying || i.destroyed) return false;
  const b = i.bounds();
  return ctx.scene.obstacles.testRect(b.left, b.top, b.right, b.bottom);
}

/**
 * "Is in the play area" asks whether the object lies wholly within the level, not whether it
 * merely touches it: something half over the edge counts as outside.
 */
function inPlayArea(scene: FrameScene, i: FusionInstance): boolean {
  const b = i.bounds();
  return b.left >= 0 && b.top >= 0 && b.right <= scene.frame.width && b.bottom <= scene.frame.height;
}

/**
 * "Closer than N pixels from the window's edge": true when the object is not wholly inside the
 * visible window shrunk by N on every side. A negative N grows the window instead, which is how
 * a level asks whether something has left the screen altogether: the game kills the player and
 * clears spent shots that way, so measuring against the level instead of the scrolling window
 * means neither ever happens on a level taller than the window.
 */
function nearEdge(scene: FrameScene, i: FusionInstance, distance: number): boolean {
  const b = i.bounds();
  const w = scene.windowBounds();
  const inside = b.left >= w.left + distance && b.top >= w.top + distance &&
                 b.right <= w.right - distance && b.bottom <= w.bottom - distance;
  return !inside;
}

/**
 * Fusion's built-in shooting animation slot. The launch actions play it themselves and refuse to
 * fire again while it is running, which is what paces a weapon's rate of fire without the game
 * needing an event for it.
 */
const SHOOTING_ANIMATION = 6;

/**
 * Shared body of the two launch actions. Both create the projectile at the shooting instance's
 * own action point; they differ only in how they work out its heading.
 *
 * The shoot parameter also names a parent object, but the runtime never places by it: the
 * shooter is always the source. Position comes from the action point rather than the hotspot,
 * which for a weapon is the muzzle.
 */
function launchFrom(
  ctx: Ctx,
  ace: AceDef,
  heading: (source: FusionInstance, muzzle: { x: number; y: number }) => number,
): void {
  const shootData = placement(ace, 0);
  const shot = typeof shootData?.['ObjectInfo'] === 'number' ? shootData['ObjectInfo'] : null;
  if (shootData === null || shot === null) return;

  const speed = Number(shootData['ShootSpeed'] ?? 0);
  const born: FusionInstance[] = [];

  for (const source of targets(ctx, ace)) {
    // An object still playing its shooting animation does not fire again.
    if (source.animation === SHOOTING_ANIMATION) continue;
    if (source.hasAnimation(SHOOTING_ANIMATION)) source.setAnimation(SHOOTING_ANIMATION);

    const muzzle = source.actionPoint();
    const created = ctx.scene.spawn(shot, muzzle.x, muzzle.y);
    if (!created) continue;

    created.setDirection(heading(source, muzzle));
    created.speed = speed;
    // The action imparts the movement; a projectile's own definition is usually Static.
    created.movement = shotState(speed);
    created.moving = true;
    born.push(created);
  }

  // Later actions in the same event address the shots just fired, not every shot on screen.
  if (born.length) select(ctx, shot, born);
}

/**
 * "Launch object toward <directions>": the heading comes from the action's direction mask,
 * unless the shoot parameter says to take the shooter's own direction instead.
 */
function launch(ctx: Ctx, ace: AceDef): void {
  const shootData = placement(ace, 0);
  if (shootData === null) return;
  const flags = placementFlags(shootData);
  // Bit 2 is "launch in selected directions disabled": the mask is greyed out in the editor and
  // the object's own facing is used.
  const useMask = (flags & 2) !== 0 && (flags & 4) === 0;
  const mask = Number(shootData['Direction'] ?? 0);

  launchFrom(ctx, ace, (source) => (useMask ? maskToDirection(mask) : source.direction));
}

/**
 * "Launch object toward a position": the heading is the angle from the shooter to that position,
 * not the direction the object being aimed at happens to face.
 */
function launchToward(ctx: Ctx, ace: AceDef): void {
  launchFrom(ctx, ace, (_source, muzzle) => {
    const target = positionOrigin(ctx, ace, 1);
    // The ray starts where the projectile does. Measuring from the shooter's hotspot instead
    // skews it by the muzzle offset: this game aims by parking a marker object on the muzzle and
    // reading its action point, which lands on exact 45-degree steps from the muzzle and a
    // degree or two off from anywhere else.
    return angleToDirection(target.x - muzzle.x, target.y - muzzle.y);
  });
}

/** "Set direction" carries a 32-bit mask of allowed directions; Fusion picks one at random. */
function maskToDirection(mask: number): number {
  if (!mask) return 0;
  const set: number[] = [];
  for (let bit = 0; bit < DIRECTION_COUNT; bit++) if (mask & (1 << bit)) set.push(bit);
  if (!set.length) return 0;
  return set[Math.floor(Math.random() * set.length)];
}

/**
 * The direction index for a vector. Fusion truncates towards zero rather than rounding, so a
 * heading lands on the direction it has already passed, not on the nearest one.
 */
/**
 * The direction index for a vector, to the nearest of the 32 directions.
 *
 * Rounding rather than truncating matters where an action point sits a pixel off a perfect
 * diagonal: a 44.65-degree aim is direction 28 to the eye and to the sprite that draws it, and
 * truncating would fire it along 29 while the gun visibly points elsewhere.
 */
export function angleToDirection(dx: number, dy: number): number {
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  const value = Math.round(degrees / -11.25);
  return ((value % DIRECTION_COUNT) + DIRECTION_COUNT) % DIRECTION_COUNT;
}

export { evaluate };
