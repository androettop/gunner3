import type { Engine, Keys } from 'excalibur';
import type { GameData } from '../data/loader';
import type {
  AceDef, EventDef, FrameDef, MusicDef, ObjectDef, ParamDef, SoundDef,
} from '../data/types';
import { isCommon } from '../data/types';
import type { AudioBank } from './audio/player';
import { ACTIONS, CONDITIONS } from './events/opcodes';
import { GlobalValues } from './globals';
import type { IniStore } from './ini';
import type { FusionInstance } from './instance';
import type { FrameScene } from './scene';

/**
 * The runtime, opened up for whoever is looking at it from a console.
 *
 * A Fusion game is its own event table running over its own objects, and when it does something
 * unexpected the question is always about that state: which instances are in the frame, what
 * their values hold, which events fired this tick and which one took something away. All of it
 * is already in the runtime; this is the way in, hung on the window beside the running game:
 *
 * ```js
 * const d = fusion.debug;
 * d.help();                    // everything below, listed
 * d.show('Level 3');           // jump to a frame by name or index
 * d.instances('Gunner');       // what is in the frame, as a table
 * d.set('Health', 0, 100);     // write an alterable value, counters included
 * d.pause(); d.step(1);        // hold the game, then hand it one tick
 * ```
 *
 * Nothing here is a copy: what comes back are the runtime's own objects, so an instance handed
 * out by `pick` is the one the events are working on and writing to it changes the game. The
 * listings are the exception, and are plain rows meant for `console.table`.
 */

/** How a thing is named: by id, by name (whole or part), by pattern, or by a test of your own. */
export type Match<T> = number | string | RegExp | ((item: T) => boolean);

/** One line of a listing of what is in the frame. */
export interface InstanceRow {
  id: number;
  object: number;
  name: string;
  x: number;
  y: number;
  direction: number;
  animation: number;
  frame: number;
  visible: boolean;
  destroying: boolean;
  values: number[];
  strings: string[];
}

/** What the debug bridge needs of the running game. */
export interface DebugHost {
  engine: Engine;
  data: GameData;
  audio: AudioBank;
  ini: IniStore;
  globals: GlobalValues;
  /** The frame being played, or null between one and the next. */
  scene: () => FrameScene | null;
  /** Jumps to a frame, as the game's own events do. */
  show: (index: number) => Promise<void>;
  /** Whether the game stops while the window belongs to somebody else. */
  pauseOnBlur: (on?: boolean) => boolean;
  /** Asks the host to look again at whether the game should be running at all. */
  awaken: () => void;
}

/** Where the choice about pausing on blur is remembered, so it outlives a reload. */
const BLUR_SETTING = 'fusion:debug:pause-on-blur';

/**
 * Whether a game should stop when its window is left, as remembered from a console.
 *
 * Debugging a game through the browser's own tools means leaving its window constantly, and a
 * game that stops every time is a game that cannot be watched while it is being poked at. The
 * answer is kept in storage rather than in the page, because the question comes up again on
 * every reload and answering it once is the point.
 */
export function pauseOnBlurWanted(): boolean {
  try {
    return localStorage.getItem(BLUR_SETTING) !== 'false';
  } catch {
    return true;
  }
}

function rememberPauseOnBlur(on: boolean): void {
  try {
    if (on) localStorage.removeItem(BLUR_SETTING);
    else localStorage.setItem(BLUR_SETTING, 'false');
  } catch {
    // Storage may be refused outright; the choice then lasts as long as the page does.
  }
}

export class Debug {
  constructor(private readonly host: DebugHost) {}

  /** The engine, for anything Excalibur's own API answers better than this does. */
  get engine(): Engine { return this.host.engine; }

  /** The game as it was packaged: the manifest, the objects, the images, the sounds. */
  get data(): GameData { return this.host.data; }

  get audio(): AudioBank { return this.host.audio; }

  get ini(): IniStore { return this.host.ini; }

  /** The frame being played, or null between one and the next. */
  scene(): FrameScene | null { return this.host.scene(); }

  // ---------------------------------------------------------------- where the game is

  /** Everything worth knowing at a glance: the frame, the tick, the camera, what is playing. */
  state(): Record<string, unknown> {
    const scene = this.scene();
    const manifest = this.data.manifest;
    return {
      game: manifest.appName,
      frame: scene ? `${scene.frame.index}: ${scene.frame.name}` : 'none',
      size: scene ? `${scene.frame.width}x${scene.frame.height}` : '',
      tick: scene?.ticks ?? 0,
      elapsed: Number((scene?.elapsed ?? 0).toFixed(2)),
      frameRate: manifest.frameRate,
      instances: scene?.instances.length ?? 0,
      camera: scene ? `${Math.round(scene.camera.pos.x)},${Math.round(scene.camera.pos.y)}` : '',
      paused: scene?.paused ?? false,
      speed: this.engine.timescale,
      questionOpen: scene?.questionOpen ?? false,
      controlIgnored: scene?.controlIgnored ?? false,
      pauseOnBlur: this.host.pauseOnBlur(),
      fps: Math.round(this.engine.clock.fpsSampler.fps),
    };
  }

  /** Every frame the game has, and which one is up. */
  frames(): Record<string, unknown>[] {
    const current = this.scene()?.frame.index;
    return this.data.frames.map((frame) => ({
      index: frame.index,
      name: frame.name,
      width: frame.width,
      height: frame.height,
      instances: frame.instances.length,
      events: frame.eventCount,
      playing: frame.index === current,
    }));
  }

  /** Jumps to a frame, by index or by name. */
  show(which: Match<FrameDef>): Promise<void> {
    const frame = filterBy(this.data.frames, which, (f) => [f.name])[0];
    if (!frame) {
      console.warn(`debug: no frame matches ${String(which)}`);
      return Promise.resolve();
    }
    return this.host.show(frame.index);
  }

  /** The next frame, the one before, and the one playing again from its start. */
  next(): Promise<void> { return this.frameAlong(1); }
  previous(): Promise<void> { return this.frameAlong(-1); }
  again(): Promise<void> { return this.frameAlong(0); }

  private frameAlong(by: number): Promise<void> {
    const at = this.scene()?.frame.index ?? 0;
    const to = Math.min(Math.max(at + by, 0), this.data.frames.length - 1);
    return this.host.show(to);
  }

  // ---------------------------------------------------------------- what the game is made of

  /** The objects the game declares, whether or not any of them is in this frame. */
  objects(match?: Match<ObjectDef>): Record<string, unknown>[] {
    const scene = this.scene();
    return this.definitions(match).map((def) => ({
      id: def.id,
      name: def.name,
      type: def.typeName,
      global: GlobalValues.isGlobal(def),
      animations: isCommon(def.detail) ? def.detail.animations.length : 0,
      inFrame: scene?.instancesOf(def.id).length ?? 0,
    }));
  }

  /** One object, as it was packaged: its animations, its movements, its starting values. */
  object(match: Match<ObjectDef>): ObjectDef | null {
    return this.definitions(match)[0] ?? null;
  }

  /** The object definitions a match names, in id order. */
  definitions(match?: Match<ObjectDef>): ObjectDef[] {
    const objects = [...this.data.objects.values()];
    if (match === undefined) return objects;
    return filterBy(objects, match, (def) => [def.name, def.typeName]);
  }

  /** What is in the frame right now, as a table. */
  instances(match?: Match<ObjectDef>): InstanceRow[] {
    return this.all(match).map((instance) => row(instance));
  }

  /**
   * The live instances a match names.
   *
   * These are the runtime's own: writing to one is writing to the game. Left out, the match
   * takes in everything in the frame.
   */
  all(match?: Match<ObjectDef>): FusionInstance[] {
    const scene = this.scene();
    if (!scene) return [];
    if (match === undefined) return [...scene.instances];
    const wanted = new Set(this.definitions(match).map((def) => def.id));
    return scene.instances.filter((instance) => wanted.has(instance.def.id));
  }

  /** The first live instance a match names, which is what an event with no selection would take. */
  pick(match: Match<ObjectDef>): FusionInstance | null {
    return this.all(match)[0] ?? null;
  }

  /** One instance by its own id, which is what the listings show in their first column. */
  instance(id: number): FusionInstance | null {
    return this.scene()?.instances.find((instance) => instance.id === id) ?? null;
  }

  /** Places another instance of an object, as a Create action does. */
  spawn(match: Match<ObjectDef>, x: number, y: number): FusionInstance | null {
    const def = this.object(match);
    const scene = this.scene();
    if (!def || !scene) return null;
    return scene.spawn(def.id, x, y);
  }

  /** Takes instances out of the frame, playing whatever they do as they go. */
  remove(match: Match<ObjectDef>): number {
    const instances = this.all(match);
    for (const instance of instances) instance.beginDestroy();
    return instances.length;
  }

  /** Moves instances to a point in the frame. */
  move(match: Match<ObjectDef>, x: number, y: number): number {
    const instances = this.all(match);
    for (const instance of instances) {
      instance.x = x;
      instance.y = y;
      instance.syncPosition();
    }
    return instances.length;
  }

  // ---------------------------------------------------------------- what the game holds

  /** The alterable values and strings of what a match names. */
  values(match?: Match<ObjectDef>): Record<string, unknown>[] {
    return this.all(match).map((instance) => ({
      id: instance.id,
      name: instance.def.name || instance.def.typeName,
      counter: instance.counterRange
        ? `${instance.counterRange.minimum}..${instance.counterRange.maximum}`
        : '',
      values: instance.values,
      strings: instance.strings,
    }));
  }

  /**
   * Writes an alterable value on everything a match names, and says how many were written.
   *
   * A counter keeps its reading in its first value and is clamped to its own range, so writing
   * one goes through the counter rather than round it: the reading is redrawn and stays inside
   * the bounds the object was built with, exactly as the game's own actions leave it.
   */
  set(match: Match<ObjectDef>, index: number, value: number): number {
    const instances = this.all(match);
    for (const instance of instances) {
      if (index === 0 && instance.counterRange) instance.setCounter(value);
      else instance.values[index] = value;
    }
    return instances.length;
  }

  /** Writes an alterable string on everything a match names. */
  setString(match: Match<ObjectDef>, index: number, value: string): number {
    const instances = this.all(match);
    for (const instance of instances) instance.strings[index] = value;
    return instances.length;
  }

  /** The application's own values and strings, which every frame shares. */
  globals(): Record<string, unknown> {
    const scene = this.scene();
    return {
      values: scene ? scene.globalValues : this.data.manifest.globalValues,
      strings: scene ? scene.globalStrings : this.data.manifest.globalStrings,
      objects: this.all().filter((i) => GlobalValues.isGlobal(i.def)).map((i) => ({
        id: i.def.id,
        name: i.def.name || i.def.typeName,
        values: i.values,
      })),
    };
  }

  setGlobal(index: number, value: number): void {
    const scene = this.scene();
    if (scene) scene.globalValues[index] = value;
  }

  setGlobalString(index: number, value: string): void {
    const scene = this.scene();
    if (scene) scene.globalStrings[index] = value;
  }

  /** The save files, as the INI extension has them. */
  saves(): Record<string, Record<string, Record<string, string>>> {
    return this.ini.dump();
  }

  /** Writes one item of a save file, without going through whatever object owns the cursor. */
  save(file: string, group: string, item: string, value: string | number): void {
    this.ini.poke(file, group, item, value);
  }

  /** Throws every save file away, which is what a fresh install looks like. */
  clearSaves(): void {
    this.ini.forget();
  }

  // ---------------------------------------------------------------- what the game is doing

  /** The frame's events, as text. A match narrows by index, by pattern or by what they say. */
  events(match?: Match<EventDef>): Record<string, unknown>[] {
    const scene = this.scene();
    if (!scene) return [];
    const groups = new Map<number, number>();
    for (const group of scene.eventGroups) for (const event of group.events) groups.set(event, group.id);

    return scene.eventTable.events
      .filter(match === undefined ? () => true : eventMatcher(match, (ace) => this.said(ace)))
      .map((event) => ({
        index: event.index,
        group: groups.get(event.index) ?? '',
        conditions: event.conditions.map((ace) => this.said(ace)).join(' + '),
        actions: event.actions.map((ace) => this.said(ace)).join(' + '),
        // An event with a part nobody implements cannot do what it says, and that is worth
        // seeing beside it rather than only after it has failed to happen.
        runs: implemented(event),
      }));
  }

  /** One event, condition by condition and action by action, with the parameters as dumped. */
  event(index: number): EventDef | null {
    return this.scene()?.eventTable.events.find((event) => event.index === index) ?? null;
  }

  /** The event groups, and whether each is switched on. */
  groups(): { id: number; active: boolean; events: number[] }[] {
    return this.scene()?.eventGroups ?? [];
  }

  /** Switches an event group on or off, as the game's own actions do. */
  group(id: number, active: boolean): void {
    this.scene()?.setGroupActive(id, active);
  }

  /**
   * Counts what fires, from now on.
   *
   * Off during normal play, because counting every event of every tick is not free. Left on
   * across a frame change, so that what a level does on its way in is counted too.
   */
  record(on = true): void {
    this.recording = on;
    this.scene()?.recordFirings(on);
  }

  /** What has fired since counting was turned on, the busiest first. */
  fired(): Record<string, unknown>[] {
    const scene = this.scene();
    if (!scene) return [];
    const ticks = scene.interpreterFiredTicks;
    return [...scene.interpreterFirings]
      .sort((a, b) => b[1] - a[1])
      .map(([index, count]) => ({
        index,
        count,
        lastTicks: (ticks.get(index) ?? []).slice(-5),
        conditions: this.event(index)?.conditions.map((ace) => this.said(ace)).join(' + ') ?? '',
      }));
  }

  /**
   * Reports the named events condition by condition, every tick, so a silent one says why.
   *
   * An event that does not fire says nothing about itself, and with a thousand of them the only
   * way to find the one condition that is wrong is to watch a single event decide.
   */
  trace(...indices: number[]): void {
    this.traced = indices;
    this.scene()?.traceEvents(indices);
  }

  /** Stops tracing, and forgets what was traced. */
  untrace(): void {
    this.traced = [];
    this.scene()?.traceEvents([]);
  }

  /** The lines the trace has collected, oldest first. */
  traceLines(): string[] {
    return this.scene()?.interpreterTrace ?? [];
  }

  /** Opcodes the interpreter met in this frame but does not implement, with hit counts. */
  unsupported(): [string, number][] {
    return this.scene()?.interpreterUnsupported ?? [];
  }

  /** What has been destroyed in this frame, and which event did it. */
  destroyed(): { name: string; event: number; conditions: string[] }[] {
    return this.scene()?.destructionLog ?? [];
  }

  // ---------------------------------------------------------------- the clock

  /**
   * Holds the game where it stands. The frame is still drawn, so it can still be looked at.
   *
   * A game held by hand is not also held by the window: its clock keeps turning, doing nothing
   * but drawing, so that a step asked for from a console arrives even though the console is
   * what the window's focus is on.
   */
  pause(): void {
    this.held = true;
    const scene = this.scene();
    if (scene) scene.paused = true;
    this.host.awaken();
  }

  /** Lets the game go again. */
  resume(): void {
    this.held = false;
    const scene = this.scene();
    if (scene) scene.paused = false;
    this.host.awaken();
  }

  /** Whether the game is being held. */
  paused(): boolean {
    return this.scene()?.paused ?? this.held;
  }

  /**
   * Hands a held game a fixed number of logic ticks, and holds it again.
   *
   * The ticks are run on the next drawn frame rather than here and now: a tick that ran inside
   * this call would be a tick run from outside the loop, with the frame half drawn.
   */
  step(ticks = 1): void {
    this.held = true;
    this.scene()?.step(ticks);
    this.host.awaken();
  }

  /** How fast time runs, 1 being as written. Asked nothing, it says what it is. */
  speed(factor?: number): number {
    if (factor !== undefined) this.engine.timescale = factor;
    return this.engine.timescale;
  }

  /**
   * Whether the game stops while its window belongs to somebody else, remembered across reloads.
   *
   * Debugging through the browser's own tools means leaving the game's window constantly, and a
   * game that stops each time cannot be watched while it is being worked on.
   */
  pauseOnBlur(on?: boolean): boolean {
    if (on !== undefined) rememberPauseOnBlur(on);
    return this.host.pauseOnBlur(on);
  }

  /**
   * Reports the values of what a match names whenever they change, tick by tick.
   *
   * The report is per logic tick rather than per drawn frame, so a value that is written and
   * written back within one tick is one line and not two, and none is missed on a slow display.
   */
  watch(...matches: Match<ObjectDef>[]): void {
    this.watched.push(...matches);
    this.attach(this.scene());
  }

  /** Stops reporting, and forgets what was watched. */
  unwatch(): void {
    this.watched = [];
    this.seen.clear();
    this.scene()?.observers.delete(this.observer);
  }

  // ---------------------------------------------------------------- input, view and sound

  /** Feeds a key press to the next tick, as though it had been typed. */
  press(...keys: string[]): void {
    this.scene()?.pressKey(...(keys as Keys[]));
  }

  /** Feeds a click to the next tick, as though the frame had been clicked on. */
  click(): void {
    this.scene()?.pressPointer();
  }

  /** Where the view is, and, given a point, where to put it. Fusion clamps it to the frame. */
  camera(x?: number, y?: number): { x: number; y: number } {
    const scene = this.scene();
    if (!scene) return { x: 0, y: 0 };
    if (x !== undefined && y !== undefined) scene.centreOn(x, y);
    return { x: scene.camera.pos.x, y: scene.camera.pos.y };
  }

  /** The sounds the game carries. */
  sounds(): Record<string, unknown>[] {
    return [...this.data.sounds.values()].map((sound) => ({
      handle: sound.handle,
      name: sound.name,
      format: sound.format,
      frequency: sound.frequency,
    }));
  }

  /** The music the game carries. */
  music(): Record<string, unknown>[] {
    return [...this.data.music.values()].map((track) => ({
      handle: track.handle,
      name: track.name,
    }));
  }

  /** Plays one of the game's sounds, by handle or by name. */
  play(match: Match<SoundDef>): void {
    const sound = filterBy([...this.data.sounds.values()], match, (s) => [s.name])[0];
    if (sound) this.audio.playSample(sound.handle);
    else console.warn(`debug: no sound matches ${String(match)}`);
  }

  /** Plays one of the game's scores, by handle or by name. */
  playMusic(match: Match<MusicDef>, loop = false): void {
    const track = filterBy([...this.data.music.values()], match, (t) => [t.name])[0];
    if (track) this.audio.playMusic(track.handle, loop);
    else console.warn(`debug: no music matches ${String(match)}`);
  }

  stopMusic(): void {
    this.audio.stopMusic();
  }

  /** How loud the two halves of the sound are, and, given levels, how loud to make them. */
  volume(music?: number, effects?: number): { music: number; effects: number } {
    if (music !== undefined) this.audio.musicVolume = music;
    if (effects !== undefined) this.audio.effectsVolume = effects;
    return { music: this.audio.musicVolume, effects: this.audio.effectsVolume };
  }

  // ---------------------------------------------------------------- keeping up with the game

  /**
   * Takes up a new frame's scene, carrying over whatever was asked for before it opened.
   *
   * A frame change builds a whole new scene, and everything set here lives on that scene. A
   * pause that ended at the door, or counting that stopped there, would be worse than useless:
   * what a level does as it opens is exactly what is worth watching.
   */
  adopt(scene: FrameScene): void {
    if (this.held) {
      scene.paused = true;
      this.host.awaken();
    }
    if (this.recording) scene.recordFirings(true);
    if (this.traced.length) scene.traceEvents(this.traced);
    this.attach(scene);
  }

  /** Prints what there is, since a bridge nobody can remember the shape of is no bridge. */
  help(): void {
    console.log([
      'fusion.debug — the runtime, from the outside. Everything returns live objects;',
      'the listings are plain rows, so console.table(...) them.',
      '',
      'where it is     state()  frames()  show(indexOrName)  next()  previous()  again()',
      'what is in it   objects(m?)  object(m)  instances(m?)  all(m?)  pick(m)  instance(id)',
      '                spawn(m, x, y)  move(m, x, y)  remove(m)',
      'what it holds   values(m?)  set(m, index, value)  setString(m, index, text)',
      '                globals()  setGlobal(i, v)  setGlobalString(i, s)',
      '                saves()  save(file, group, item, value)  clearSaves()',
      'what it does    events(m?)  event(index)  groups()  group(id, on)',
      '                record(on?)  fired()  trace(...indices)  untrace()  traceLines()',
      '                unsupported()  destroyed()',
      'the clock       pause()  resume()  paused()  step(ticks?)  speed(factor?)',
      '                pauseOnBlur(on?)   watch(...m)  unwatch()',
      'in and out      press("Space")  click()  camera(x?, y?)',
      '                sounds()  music()  play(m)  playMusic(m, loop?)  stopMusic()  volume(m?, e?)',
      'the raw things  engine  data  audio  ini  scene()',
      '',
      'A match m is an id, a name (whole or part, case-insensitive), a /pattern/, or a function.',
    ].join('\n'));
  }

  // ---------------------------------------------------------------- private

  private held = false;
  private recording = false;
  private traced: number[] = [];
  private watched: Match<ObjectDef>[] = [];
  private readonly seen = new Map<number, string>();

  private readonly observer = (scene: FrameScene): void => {
    for (const match of this.watched) {
      for (const instance of this.all(match)) {
        const now = `${instance.values.join(',')} | ${instance.strings.join(',')} | ` +
          `a${instance.animation} d${instance.direction} ${instance.visible ? 'shown' : 'hidden'}`;
        const before = this.seen.get(instance.id);
        this.seen.set(instance.id, now);
        if (before === undefined || before === now) continue;
        console.log(`t=${scene.ticks} ${instance.def.name || instance.def.typeName}` +
          `#${instance.id}  ${before}  ->  ${now}`);
      }
    }
  };

  /**
   * What a condition or an action is, in as many words as there are.
   *
   * The editor's own wording is not in the game: the strings that made up "Gunner collides with
   * Wall" live in the editor rather than in what it builds, so an event dumped out of a finished
   * game is opcodes and object references. What can be said is which object it is about and
   * which opcode it is, and that is enough to find an event and to know it again.
   */
  private said(ace: AceDef): string {
    const opcode = opcodeOf(ace);
    // Only an opcode belonging to an object kind is about an object. The rest are the system's
    // own (the timer, the keyboard, the frame itself) and carry an object reference that means
    // nothing: naming it puts the player's name on the start of the frame.
    const about = ace.objectType >= 0 && this.data.objects.has(ace.objectInfo)
      ? this.data.objectName(ace.objectInfo)
      : '';
    const parameters = ace.parameters.map(plainly).filter(Boolean).join(', ');
    return [ace.text || opcode, about && `on ${about}`, parameters && `(${parameters})`]
      .filter(Boolean).join(' ');
  }

  private attach(scene: FrameScene | null): void {
    if (!scene) return;
    if (this.watched.length) scene.observers.add(this.observer);
    else scene.observers.delete(this.observer);
  }
}

/** One row of a listing of what is in the frame. */
function row(instance: FusionInstance): InstanceRow {
  return {
    id: instance.id,
    object: instance.def.id,
    name: instance.def.name || instance.def.typeName,
    x: Math.round(instance.x),
    y: Math.round(instance.y),
    direction: instance.direction,
    animation: instance.animation,
    frame: instance.animationFrame,
    visible: instance.visible,
    destroying: instance.destroying,
    values: instance.values,
    strings: instance.strings,
  };
}

/** Whether every opcode an event is made of is one the interpreter implements. */
function implemented(event: EventDef): boolean {
  return event.conditions.every((ace) => opcodeOf(ace) in CONDITIONS)
    && event.actions.every((ace) => opcodeOf(ace) in ACTIONS);
}

function opcodeOf(ace: AceDef): string {
  return `${ace.objectType}:${ace.num}`;
}

/** A parameter, when it is a plain number or a piece of text rather than an expression tree. */
function plainly(parameter: ParamDef): string {
  const value = parameter.data?.['Value'];
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

/**
 * The things a match names, out of a list of them.
 *
 * A number is an id, since that is the one thing about a Fusion object that never moves; what
 * counts as one depends on the thing, and each of them has exactly one. A string is matched
 * against the names offered: everything named exactly that, and only if nothing is, everything
 * whose name contains it. That way an object called "Gun" is not lost among the twenty whose
 * names merely contain it, while a half-remembered name still finds what it was reaching for.
 */
function filterBy<T>(items: T[], match: Match<T>, names: (item: T) => string[]): T[] {
  if (typeof match === 'function') return items.filter((item) => match(item));
  if (typeof match === 'number') return items.filter((item) => idOf(item) === match);
  if (match instanceof RegExp) return items.filter((item) => names(item).some((n) => match.test(n)));

  const wanted = match.trim().toLowerCase();
  const named = (item: T, test: (name: string) => boolean) => names(item).some(test);
  const exact = items.filter((item) => named(item, (name) => name.toLowerCase() === wanted));
  return exact.length
    ? exact
    : items.filter((item) => named(item, (name) => name.toLowerCase().includes(wanted)));
}

/** What a thing answers to as a number: an object by its id, a sound by its handle, a frame by
 * its index. Each kind carries one of them, so the first one it has is the one it is known by. */
function idOf(item: unknown): number | undefined {
  const record = item as Record<string, unknown>;
  for (const key of ['id', 'handle', 'index']) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Events are matched by their index, or by what they are made of: an opcode, an object's name,
 * or anything else that turns up in how the event describes itself.
 */
function eventMatcher(
  match: Match<EventDef>,
  said: (ace: AceDef) => string,
): (event: EventDef) => boolean {
  if (typeof match === 'function') return match;
  if (typeof match === 'number') return (event) => event.index === match;
  const test = match instanceof RegExp
    ? (text: string) => match.test(text)
    : (text: string) => text.toLowerCase().includes(match.trim().toLowerCase());
  return (event) => [...event.conditions, ...event.actions].some((ace) => test(said(ace)));
}
