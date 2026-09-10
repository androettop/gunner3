import { Engine, Keys } from 'excalibur';
import type { AceDef, EventDef, FrameEvents, ParamDef } from '../../data/types';
import type { FusionInstance } from '../instance';
import type { FrameScene } from '../scene';
import { evaluate, evaluateString } from './expression';
import { CONDITIONS, ACTIONS, type Ctx } from './opcodes';

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

  /** Every group the frame declares, which events belong to it, and whether it is switched on. */
  groups(): { id: number; active: boolean; events: number[] }[] {
    const events = new Map<number, number[]>();
    for (const [event, group] of this.groupOfEvent) {
      const list = events.get(group);
      if (list) list.push(event);
      else events.set(group, [event]);
    }
    return [...this.activeGroups].map(([id, active]) => ({
      id,
      active,
      events: events.get(id) ?? [],
    }));
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

    for (const event of this.events) {
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
      };

      if (!this.testConditions(ctx, event)) continue;
      if (this.recordFirings) this.noteFiring(event.index);
      this.runActions(ctx, event);
    }

    this.startFlag = false;
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
      const handler = CONDITIONS[opcode(condition)];
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
          !tracksItsOwnEdges(condition)) {
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
      const handler = ACTIONS[opcode(action)];
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

  private noteUnsupported(kind: string, ace: AceDef): void {
    const id = `${kind} ${opcode(ace)}: ${ace.text}`;
    this.unsupported.set(id, (this.unsupported.get(id) ?? 0) + 1);
  }
}

export function opcode(ace: AceDef): string {
  return `${ace.objectType}:${ace.num}`;
}

/** Group start/end markers delimit events; they are structure, not state to edge-detect. */
function isStructural(ace: AceDef): boolean {
  return ace.objectType === -1 && (ace.num === -10 || ace.num === -11);
}

/** Collision opcodes edge-detect per colliding pair instead of on a single boolean. */
function tracksItsOwnEdges(ace: AceDef): boolean {
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
