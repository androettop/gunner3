import { Engine, Keys } from 'excalibur';
import type { AceDef, EventDef, FrameEvents, ParamDef } from '../../data/types';
import type { FusionInstance } from '../instance';
import type { FrameScene } from '../scene';
import { evaluate, evaluateString } from './expression';
import { CONDITIONS, ACTIONS, type ActionFn, type ConditionFn, type Ctx } from './opcodes';
import { extensionOf } from './extensions';

/**
 * Runs a frame's dumped event table.
 *
 * Fusion evaluates every event once per game tick, top to bottom: the conditions of an event
 * filter which instances are "selected", and its actions then apply to that selection. This
 * implements that loop plus the per-event selection scope, with opcodes registered in
 * ./opcodes.
 */
export class EventInterpreter {
  private readonly events: EventDef[];
  private readonly onceTriggered = new Set<number>();
  private readonly everyTimers = new Map<string, number>();
  private started = false;
  /** Set for exactly one tick after the frame opens, for "Start of Frame". */
  private startFlag = false;

  readonly unsupported = new Map<string, number>();

  /**
   * Diagnostics, off unless something asks for them: which events ran, and on which ticks.
   * Sampling from outside cannot tell a repeat within one tick from one across two, and that
   * distinction is what separates an event firing twice from two things happening in a row.
   */
  recordFirings = false;
  readonly firings = new Map<number, number>();
  readonly firedTicks = new Map<number, number[]>();

  /**
   * Events to report condition by condition. An event that does not fire says nothing about why,
   * and with a thousand of them the only way to find the one condition that is wrong is to watch
   * a single event decide.
   */
  readonly traced = new Set<number>();
  readonly trace: string[] = [];

  /** Event index -> id of the group it belongs to, from the group start/end markers. */
  private readonly groupOfEvent = new Map<number, number>();
  private readonly activeGroups = new Map<number, boolean>();

  constructor(
    private readonly scene: FrameScene,
    eventData: FrameEvents,
    private readonly engine: Engine,
  ) {
    this.events = eventData.events;
    this.mapGroups();
  }

  /**
   * Events are wrapped in groups delimited by marker conditions: -1:-10 opens a group and
   * -1:-11 closes it. A group whose InactiveOnStart flag is set stays dormant until an event
   * activates it, and its events are skipped meanwhile.
   */
  private mapGroups(): void {
    const stack: number[] = [];
    for (const event of this.events) {
      for (const condition of event.conditions) {
        if (condition.objectType !== -1) continue;
        if (condition.num === -10) {
          const data = condition.parameters[0]?.data;
          const id = Number(data?.['ID'] ?? stack.length);
          const flags = Number(data?.['GroupFlags']?.['Value'] ?? 0);
          // Bit 0 is InactiveOnStart; bit 1 is "collapsed in the editor" and means nothing here.
          this.activeGroups.set(id, (flags & 1) === 0);
          stack.push(id);
        } else if (condition.num === -11) {
          stack.pop();
        }
      }
      if (stack.length) this.groupOfEvent.set(event.index, stack[stack.length - 1]);
    }
  }

  setGroupActive(id: number, active: boolean): void {
    this.activeGroups.set(id, active);
  }

  private groupActive(eventIndex: number): boolean {
    const group = this.groupOfEvent.get(eventIndex);
    if (group === undefined) return true;
    return this.activeGroups.get(group) !== false;
  }

  startOfFrame(): void {
    this.started = true;
    this.startFlag = true;
  }

  run(delta: number): void {
    if (!this.started) return;
    this.pass(delta, null);
    this.startFlag = false;
  }

  /**
   * One walk down the event list.
   *
   * `loop` names the fast loop being run, and is null for the ordinary once-a-tick pass. Inside
   * a loop only the events that ask for it are considered, so a loop costs what its own events
   * cost rather than a full pass of the table per iteration.
   */
  private pass(delta: number, loop: string | null): void {
    for (const event of this.events) {
      if (loop !== null && !this.mentionsLoop(event)) continue;
      if (!this.groupActive(event.index)) {
        if (this.traced.has(event.index))
          this.note(`t=${this.scene.ticks} ${event.index} skipped: group ` +
            `${this.groupOfEvent.get(event.index)} inactive`);
        continue;
      }

      const ctx: Ctx = {
        scene: this.scene,
        engine: this.engine,
        delta,
        selection: new Map(),
        negationApplied: false,
        startOfFrame: this.startFlag,
        conditionKey: '',
        interpreter: this,
        event,
        loop,
      };

      if (!this.testConditions(ctx, event)) continue;
      if (this.recordFirings) this.noteFiring(event.index);
      this.runActions(ctx, event);
    }
  }

  // ------------------------------------------------------------------ fast loops

  /** How deep one fast loop may start another, so a loop that starts itself cannot hang the tab. */
  private static readonly MAX_LOOP_DEPTH = 16;

  private readonly loopIndices = new Map<string, number>();
  private readonly stoppedLoops = new Set<string>();
  private loopDepth = 0;
  /** Events carrying an "on loop" condition, which are the only ones a loop runs. */
  private loopEvents: Set<number> | null = null;

  private mentionsLoop(event: EventDef): boolean {
    if (this.loopEvents === null) {
      this.loopEvents = new Set(
        this.events
          .filter((e) => e.conditions.some((c) => c.objectType === -1 && c.num === -16))
          .map((e) => e.index),
      );
    }
    return this.loopEvents.has(event.index);
  }

  /**
   * "Start loop": runs the named loop then and there, before the action after it.
   *
   * The iterations happen inside the action that asked for them rather than being spread over
   * the ticks that follow, which is the whole point of a fast loop: a level uses one to step a
   * projectile forward a pixel at a time and check what it hit, and all of that has to resolve
   * within the tick that fired the shot.
   *
   * Each iteration is given no elapsed time, so the "every N" timers that pace the game are not
   * advanced once per iteration by a loop that runs a hundred of them in a tick.
   */
  runLoop(name: string, count: number): void {
    if (name === '' || count <= 0) return;
    if (this.loopDepth >= EventInterpreter.MAX_LOOP_DEPTH) return;

    this.stoppedLoops.delete(name);
    this.loopDepth++;
    try {
      for (let index = 0; index < count; index++) {
        if (this.stoppedLoops.has(name)) break;
        this.loopIndices.set(name, index);
        this.pass(0, name);
      }
    } finally {
      this.loopDepth--;
      this.stoppedLoops.delete(name);
    }
  }

  /** "Stop loop": the loop finishes the iteration it is in and runs no more. */
  stopLoop(name: string): void {
    this.stoppedLoops.add(name);
  }

  /**
   * The index a loop has reached, which its events read to know which pass they are on. Fusion
   * leaves the last index readable after the loop ends, so it is not cleared here.
   */
  loopIndex(name: string): number {
    return this.loopIndices.get(name) ?? 0;
  }

  /**
   * "Only one action when event loops": the event fires once and then holds until its conditions
   * stop being met, which re-arms it. Latched permanently instead, an event like "count a shot
   * as the firing animation reaches its second frame" fires once in the whole level, and every
   * counter it was pacing runs away.
   */
  private readonly rearmed = new Map<number, boolean>();

  private notAlways(event: EventDef): boolean {
    return event.conditions.some((c) => c.objectType === -1 && c.num === -7);
  }

  private testConditions(ctx: Ctx, event: EventDef): boolean {
    const once = this.notAlways(event);
    for (let index = 0; index < event.conditions.length; index++) {
      const condition = event.conditions[index];
      // Handled after the rest have had their say, since it depends on all of them passing.
      if (condition.objectType === -1 && condition.num === -7) continue;
      const handler = CONDITIONS[opcode(condition)] ?? this.extensionHandler(condition, 'condition');
      if (!handler) {
        this.noteUnsupported('condition', condition);
        // An unimplemented condition must not let the event fire on its own.
        return false;
      }

      ctx.conditionKey = `${event.index}:${index}`;
      ctx.negationApplied = false;
      const raw = handler(ctx, condition);
      if (this.traced.has(event.index))
        this.note(`t=${this.scene.ticks} ${event.index}.${index} ${opcode(condition)}` +
          `${condition.negated ? ' (negated)' : ''} raw=${raw} "${condition.text}"`);
      // A condition that narrows a selection applies its own negation, keeping the instances it
      // is false for; inverting the outcome again would undo that.
      const value = condition.negated && !ctx.negationApplied ? !raw : raw;

      // Only an event's first condition can be a trigger, firing as its state becomes true
      // rather than for as long as it stays true. The flag appears on later conditions too, but
      // there it means nothing and they are ordinary tests: a level that kills the player with
      // "timer past two seconds AND player off the bottom of the screen" puts the timer second,
      // and edge-detecting it consumes the event two seconds in, long before anyone falls.
      //
      // Collision opcodes are excluded wherever they sit, because they edge-detect per colliding
      // pair instead of on one boolean; a single flag would miss a new pair forming while an
      // older overlap is still in progress.
      if (index === 0 && condition.always === false && !isStructural(condition) &&
          !tracksItsOwnEdges(condition) && !isTest(condition)) {
        if (!this.risingEdge(ctx.conditionKey, value)) {
          if (once) this.rearmed.set(event.index, true);
          if (this.traced.has(event.index)) this.note(`  -> stopped at ${index}: no rising edge`);
          return false;
        }
      } else if (!value) {
        if (once) this.rearmed.set(event.index, true);
        if (this.traced.has(event.index)) this.note(`  -> stopped at ${index}`);
        return false;
      }
    }

    if (once) {
      if (this.rearmed.get(event.index) === false) {
        if (this.traced.has(event.index)) this.note('  -> stopped: not re-armed');
        return false;
      }
      this.rearmed.set(event.index, false);
    }
    return true;
  }

  private note(line: string): void {
    this.trace.push(line);
    if (this.trace.length > 4000) this.trace.shift();
  }

  private noteFiring(index: number): void {
    this.firings.set(index, (this.firings.get(index) ?? 0) + 1);
    const ticks = this.firedTicks.get(index) ?? [];
    ticks.push(this.scene.ticks);
    if (ticks.length > 200) ticks.shift();
    this.firedTicks.set(index, ticks);
  }

  private readonly edges = new Map<string, boolean>();

  /** True only on the tick where `value` goes from false to true. */
  private risingEdge(key: string, value: boolean): boolean {
    const previous = this.edges.get(key) ?? false;
    this.edges.set(key, value);
    return value && !previous;
  }

  private readonly pairs = new Map<string, Set<string>>();

  /**
   * Pairs that were not colliding on the previous evaluation of this condition.
   *
   * Fusion fires a collision once per pair as it forms. A single boolean edge would miss a new
   * pair forming while an older overlap is still in progress, which happens constantly with
   * several shots in flight at once.
   */
  freshPairs(key: string, current: Set<string>): Set<string> {
    const previous = this.pairs.get(key) ?? new Set<string>();
    this.pairs.set(key, current);
    const fresh = new Set<string>();
    for (const pair of current) if (!previous.has(pair)) fresh.add(pair);
    return fresh;
  }

  private runActions(ctx: Ctx, event: EventDef): void {
    for (const action of event.actions) {
      const handler = ACTIONS[opcode(action)] ?? this.extensionHandler(action, 'action');
      if (!handler) {
        this.noteUnsupported('action', action);
        continue;
      }
      try {
        handler(ctx, action);
      } catch (e) {
        console.warn(`action ${opcode(action)} (${action.text}) failed:`, e);
      }
    }
  }

  /** "Only one action when event loops" / "Run this event once" bookkeeping. */
  triggerOnce(eventIndex: number): boolean {
    if (this.onceTriggered.has(eventIndex)) return false;
    this.onceTriggered.add(eventIndex);
    return true;
  }

  releaseOnce(eventIndex: number): void {
    this.onceTriggered.delete(eventIndex);
  }

  /**
   * "Every N", where N is in milliseconds.
   *
   * The timer conditions settle the unit: one displayed as 1 second 50 hundredths stores 1500.
   * Reading these as hundredths made every periodic event ten times too slow, which showed up
   * most clearly in the jump: its height counter is decremented on an "Every 60", so the
   * player kept rising for 0.6s per step and sailed off the top of the level.
   */
  every(id: string, milliseconds: number, delta: number): boolean {
    const period = Math.max(milliseconds, 1) / 1000;
    const elapsed = (this.everyTimers.get(id) ?? 0) + delta;
    if (elapsed < period) {
      this.everyTimers.set(id, elapsed);
      return false;
    }
    this.everyTimers.set(id, elapsed - period);
    return true;
  }

  /**
   * The handler an extension object's opcode resolves to.
   *
   * Extension ACEs count from 80 in a namespace of the extension's own, and which extension a
   * type number means is decided by the game it was built into, so the lookup goes through the
   * object rather than through the type. See ./extensions.
   */
  private extensionHandler(ace: AceDef, kind: 'condition'): ConditionFn | undefined;
  private extensionHandler(ace: AceDef, kind: 'action'): ActionFn | undefined;
  private extensionHandler(ace: AceDef, kind: 'condition' | 'action'): ConditionFn | ActionFn | undefined {
    if (ace.objectType >= 32) {
      const set = extensionOf(this.scene.data.objects.get(ace.objectInfo));
      const own = kind === 'condition' ? set?.conditions?.[ace.num] : set?.actions?.[ace.num];
      if (own) return own;
    }
    return commonHandler(ace, kind);
  }

  private noteUnsupported(kind: string, ace: AceDef): void {
    const id = `${kind} ${opcode(ace)}: ${ace.text}`;
    this.unsupported.set(id, (this.unsupported.get(id) ?? 0) + 1);
  }
}

export function opcode(ace: AceDef): string {
  return `${ace.objectType}:${ace.num}`;
}

/**
 * The handler for an opcode every object type shares.
 *
 * Fusion gives each kind of object its own opcodes from 80 up, but everything below that is the
 * same set for all of them: destroying, hiding, moving and the alterable values are one
 * implementation the engine applies to a counter, a text object or an extension exactly as it
 * does to an Active. They are registered once, against the Active, and reached from the other
 * types here rather than being listed again under each.
 */
function commonHandler(ace: AceDef, kind: 'condition' | 'action'): ConditionFn | ActionFn | undefined {
  if (ace.objectType <= 2) return undefined;
  const common = kind === 'condition' ? ace.num > -81 : ace.num < 80;
  if (!common) return undefined;
  return kind === 'condition' ? CONDITIONS[`2:${ace.num}`] : ACTIONS[`2:${ace.num}`];
}

/** Group start/end markers delimit events; they are structure, not state to edge-detect. */
function isStructural(ace: AceDef): boolean {
  return ace.objectType === -1 && (ace.num === -10 || ace.num === -11);
}

/**
 * Conditions that read as a test however they are flagged.
 *
 * "Timer is greater than" stays true for the rest of the frame once the clock passes the mark,
 * and the game writes it as the standing part of an event whose trigger is somewhere else:
 * "once the screen has settled, and the player clicks this box, start the level". Edge-detecting
 * it consumes the event at the moment the timer passes, and the click that arrives later then
 * has nothing left to fire, which is a level-select screen whose boxes do nothing.
 */
function isTest(ace: AceDef): boolean {
  return ace.objectType === -4 && ace.num === -1;
}

/**
 * Conditions that decide their own triggering, and must not be edge-detected on top of it.
 *
 * Collisions edge-detect per colliding pair rather than on a single boolean, so one flag would
 * miss a new pair forming while an older overlap is still in progress.
 *
 * "On loop" is true for every iteration of the loop it names, and each iteration is a fresh
 * trigger. Taking only its rising edge lets an event through on the first iteration and never
 * again, which leaves a loop running its full count while the events that were supposed to do
 * the work fire once: the level select builds a save file with a chain of loops, each starting
 * the next as it ends, and the chain stopped dead on the first link.
 */
function tracksItsOwnEdges(ace: AceDef): boolean {
  if (ace.objectType === -1 && ace.num === -16) return true;
  return ace.objectType === 2 && (ace.num === -14 || ace.num === -13);
}

/** Instances an ACE applies to: its own object, narrowed by anything already selected. */
export function targets(ctx: Ctx, ace: AceDef): FusionInstance[] {
  return instancesFor(ctx, ace.objectInfo);
}

/**
 * The instances of an object as this event sees them: the selection its conditions narrowed it
 * to, or every instance if nothing narrowed it.
 *
 * Parameters that name an object have to go through this too. "Create an explosion at the
 * bullet" inside a collision event means the bullet that collided, not whichever bullet happens
 * to be first in the scene.
 */
export function instancesFor(ctx: Ctx, objectId: number): FusionInstance[] {
  // A selection is a list the conditions captured, and destroying an instance does not remove it
  // from that list, so the actions after a "destroy" in the same event still act on it. Games
  // rely on this constantly: a shot is destroyed on impact and the debris, sparks or blood are
  // then created "at" that same shot. Filtering the dead out here makes all of it vanish.
  const selected = ctx.selection.get(objectId);
  if (selected) return selected;
  return ctx.scene.instancesOf(objectId);
}

export function select(ctx: Ctx, objectId: number, instances: FusionInstance[]): void {
  ctx.selection.set(objectId, instances);
}

export function param(ace: AceDef, index: number): ParamDef | undefined {
  return ace.parameters[index];
}

/**
 * Resolver for object references inside this event's expressions: an object named in one means
 * the instance the event has narrowed to, not the first of its kind in the level.
 */
export function resolver(ctx: Ctx): (objectId: number) => FusionInstance | undefined {
  return (objectId) => instancesFor(ctx, objectId)[0];
}

export function num(ctx: Ctx, ace: AceDef, index: number): number {
  const p = param(ace, index);
  if (!p) return 0;
  if (p.type === 'ParameterExpressions') return evaluate(ctx.scene, p, resolver(ctx));
  const value = p.data?.['Value'];
  return typeof value === 'number' ? value : Number(p.value) || 0;
}

export function text(ctx: Ctx, ace: AceDef, index: number): string {
  const p = param(ace, index);
  if (!p) return '';
  if (p.type === 'ParameterExpressions') return evaluateString(ctx.scene, p, resolver(ctx));
  return String(p.data?.['Value'] ?? p.value ?? '');
}

/**
 * Windows virtual key codes to browser keys.
 *
 * The conditions store raw VK codes, and a title can bind any of them, so a partial table
 * silently drops whatever inputs it happens to omit.
 */
const KEY_MAP: Record<number, Keys[]> = {
  8: [Keys.Backspace],
  9: [Keys.Tab],
  13: [Keys.Enter],
  16: [Keys.ShiftLeft, Keys.ShiftRight],
  17: [Keys.ControlLeft, Keys.ControlRight],
  18: [Keys.AltLeft, Keys.AltRight],
  20: [Keys.CapsLock],
  27: [Keys.Escape],
  32: [Keys.Space],
  33: [Keys.PageUp],
  34: [Keys.PageDown],
  35: [Keys.End],
  36: [Keys.Home],
  37: [Keys.ArrowLeft],
  38: [Keys.ArrowUp],
  39: [Keys.ArrowRight],
  40: [Keys.ArrowDown],
  45: [Keys.Insert],
  46: [Keys.Delete],
};

// Digits 0-9, letters A-Z, numpad 0-9 and F1-F12 follow their VK ranges directly.
for (let i = 0; i <= 9; i++) {
  KEY_MAP[48 + i] = [`Digit${i}` as Keys];
  KEY_MAP[96 + i] = [`Numpad${i}` as Keys];
}
for (let i = 0; i < 26; i++) {
  KEY_MAP[65 + i] = [`Key${String.fromCharCode(65 + i)}` as Keys];
}
for (let i = 1; i <= 12; i++) {
  KEY_MAP[111 + i] = [`F${i}` as Keys];
}

export function keysFor(code: number): Keys[] {
  return KEY_MAP[code] ?? [];
}

/**
 * The virtual key codes a browser key stands for, which is the table above read backwards.
 *
 * One key can answer to more than one code where the codes do not distinguish the two shift or
 * control keys, so this yields every code that names it.
 */
const CODE_MAP = new Map<Keys, number[]>();
for (const [code, keys] of Object.entries(KEY_MAP)) {
  for (const key of keys) {
    const codes = CODE_MAP.get(key);
    if (codes) codes.push(Number(code));
    else CODE_MAP.set(key, [Number(code)]);
  }
}

export function codesForKey(key: Keys): number[] {
  return CODE_MAP.get(key) ?? [];
}
