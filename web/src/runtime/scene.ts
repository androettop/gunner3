import { Color, Engine, type Keys, Scene, Vector } from 'excalibur';
import type { GameData } from '../data/loader';
import type { FrameDef, FrameEvents } from '../data/types';
import { FusionInstance } from './instance';
import { SpriteStore } from './sprites';
import { EventInterpreter } from './events/interpreter';
import { ObstacleMask } from './obstacles';
import { clearedWhenTooFar, tooFarOutside, update as updateMovement } from './movement';
import type { AudioBank } from './audio/player';
import { GlobalValues } from './globals';
import { IniStore } from './ini';
import { Actor } from 'excalibur';
import { answerAt, layOut, questionFor, questionGraphic, type PendingQuestion } from './question';

/**
 * Backdrops occupy a band far below everything else. Fusion always draws them behind active
 * objects, whatever the ordering actions do: "bring to back" sends an object behind the other
 * actives, not behind the scenery. Sharing one range put the player's arm underneath the level.
 */
/** Cap on catch-up steps, so a stalled tab does not then run a burst of logic. */
const MAX_CATCHUP_TICKS = 5;

const BACKDROP_Z = -1_000_000;
const FRONT_Z = 1_000_000;
/** A question's panel is drawn over everything, including anything brought to front. */
const QUESTION_Z = 2_000_000;
import { isBackdrop, isQuickBackdrop } from '../data/types';

/** A Fusion frame brought up as an Excalibur scene. */
export class FrameScene extends Scene {
  readonly instances: FusionInstance[] = [];
  /** Instances grouped by the object definition they came from, which is how events address them. */
  readonly byObject = new Map<number, FusionInstance[]>();

  readonly globalValues: number[];
  readonly globalStrings: string[];

  private interpreter: EventInterpreter | null = null;
  /** Solid pixels of every obstacle backdrop, plus anything pasted at runtime. */
  readonly obstacles: ObstacleMask;
  /** Save-game state, shared across frames by the host. */
  ini: IniStore = new IniStore();
  /** Alterable values of global objects, carried between frames by the host. */
  globals: GlobalValues = new GlobalValues();
  audio: AudioBank | null = null;
  /** Set by the host so "jump to frame" can change scenes. */
  onJumpToFrame: ((index: number) => void) | null = null;
  onEndApplication: (() => void) | null = null;
  /** Fusion's "ignore control" disables the player's input until control is restored. */
  controlIgnored = false;

  /** While a Question object is open the event loop is paused, as in Fusion. */
  questionOpen = false;
  /** Last answer picked per Question object, 1-based. */
  readonly answers = new Map<number, number>();

  private question: PendingQuestion | null = null;
  private questionActor: Actor | null = null;
  private questionHover: number | null = null;
  private questionPressed = false;

  /**
   * Puts a Question object's panel on screen at the point the action names.
   *
   * The panel is an actor like anything else in the frame, drawn over the rest of it, so it
   * moves and scales with the picture instead of floating above the page.
   */
  ask(objectId: number, x: number, y: number): void {
    if (this.questionOpen) return;
    const def = this.data.objects.get(objectId);
    const items = def ? questionFor(def, this.data.fonts) : null;
    if (!items || !items.answers.length) return;

    const layout = layOut(items.question, items.answers);
    this.question = { objectId, x, y, layout };
    this.questionHover = null;
    this.questionPressed = false;
    this.questionOpen = true;
    this.answers.delete(objectId);

    const actor = new Actor({ x, y, z: QUESTION_Z });
    actor.graphics.use(questionGraphic(layout, () => ({
      hovered: this.questionHover,
      pressed: this.questionPressed,
    })));
    actor.graphics.offset = new Vector(layout.width / 2, layout.height / 2);
    this.questionActor = actor;
    this.add(actor);
  }

  /** Which answer the pointer is over, or null when it is off the panel. */
  private updateQuestionHover(): void {
    if (!this.question) return;
    const at = this.pointerPosition();
    this.questionHover = at
      ? answerAt(this.question.layout, at.x - this.question.x, at.y - this.question.y)
      : null;
  }

  /** Takes the answer under the pointer, closes the panel and lets the event loop go again. */
  private takeAnswer(): void {
    const pending = this.question;
    if (!pending) return;
    this.updateQuestionHover();
    const chosen = this.questionHover;
    this.questionPressed = false;
    if (chosen === null) return;

    this.questionActor?.kill();
    this.questionActor = null;
    this.question = null;
    this.questionHover = null;
    this.questionOpen = false;
    this.answers.set(pending.objectId, chosen + 1);
  }

  // Monotonic z counters so repeated bring-to-front/back calls keep their relative order.
  private frontZ = FRONT_Z;
  private backZ = 0;

  bringToFront(instance: FusionInstance): void {
    instance.actor.z = ++this.frontZ;
  }

  bringToBack(instance: FusionInstance): void {
    instance.actor.z = --this.backZ;
  }
  /**
   * Key presses and clicks seen since the last logic tick.
   *
   * Input state on the engine lasts one rendered frame, and logic runs on its own fixed clock,
   * so a frame can go by without a tick in it: on a display faster than the game's rate, most
   * of them do. A press landing in one of those is cleared before any event can ask about it,
   * which is a jump that does not happen. Latching them here means a press is never lost,
   * whatever the display is doing, and is consumed exactly once.
   */
  private readonly pressedKeys = new Set<Keys>();
  private pointerPressed = false;

  wasPressed(keys: Keys[]): boolean {
    return keys.some((k) => this.pressedKeys.has(k));
  }

  wasClicked(): boolean {
    return this.pointerPressed;
  }

  /** Logic ticks run since the frame opened. */
  ticks = 0;
  private frameTime = 0;
  /** Unspent time carried between renders, so logic advances at a fixed rate. */
  private tickAccumulator = 0;

  constructor(
    readonly data: GameData,
    readonly frame: FrameDef,
    readonly sprites: SpriteStore,
    private readonly eventData: FrameEvents,
  ) {
    super();
    this.globalValues = [...data.manifest.globalValues];
    this.globalStrings = [...data.manifest.globalStrings];
    this.obstacles = new ObstacleMask(frame.width, frame.height);
  }

  static async create(data: GameData, index: number, sprites: SpriteStore): Promise<FrameScene> {
    const frame = data.frame(index);
    const events = await data.frameEvents(index);
    return new FrameScene(data, frame, sprites, events);
  }

  onInitialize(engine: Engine): void {
    this.backgroundColor = Color.fromHex(this.frame.background);

    for (const def of this.frame.instances) {
      const objectDef = this.data.objects.get(def.objectInfo);
      if (!objectDef) continue;

      // Fusion keeps "fake" instances in the frame purely so Create actions have something to
      // copy; it never places them. All 52 of this level's sit at the origin, which is exactly
      // the pile of stray objects that showed up at 0,0.
      if (def.flags?.['CreateOnly']) continue;

      const instance = new FusionInstance(objectDef, def.x, def.y, this.data, this.sprites);
      // Backdrops sit behind everything; instance order decides the rest.
      // Backdrops, and anything the object declares as background, order behind the actors.
      instance.actor.z = instance.isBackgroundLayer
        ? BACKDROP_Z + this.instances.length
        : this.instances.length;

      this.instances.push(instance);
      const group = this.byObject.get(objectDef.id);
      if (group) group.push(instance);
      else this.byObject.set(objectDef.id, [instance]);

      this.add(instance.actor);
      this.addObstacle(instance);
    }

    engine.input.keyboard.on('press', (e) => this.pressedKeys.add(e.key));
    engine.input.pointers.primary.on('down', () => {
      if (this.questionOpen) { this.updateQuestionHover(); this.questionPressed = true; return; }
      this.pointerPressed = true;
    });
    // A question is answered on release over a button, the way the runtime's own panel works:
    // pressing one and sliding off it picks nothing.
    engine.input.pointers.primary.on('up', () => {
      if (this.questionOpen && this.questionPressed) this.takeAnswer();
    });

    // Before any event runs: a global object arrives holding what it was left holding, so the
    // frame's own start-up events see the loaded state rather than the defaults.
    this.applyGlobals();

    this.interpreter = new EventInterpreter(this, this.eventData, engine);
    this.interpreter.startOfFrame();

    this.camera.pos = new Vector(
      this.data.manifest.windowWidth / 2,
      this.data.manifest.windowHeight / 2,
    );
    this.camera.zoom = 1;
  }

  /**
   * Holds the game's logic where it stands, with the picture still being drawn.
   *
   * Nothing in the game pauses itself; this is here for whoever is looking at it from outside.
   * Stopping the clock instead would hold the drawing too, and a game that is not being drawn
   * cannot be looked at, moved around or asked what it is showing.
   */
  paused = false;

  /** Ticks promised to a paused game, handed to it one loop at a time. */
  private stepsOwed = 0;

  /** Runs a fixed number of logic ticks and holds again, whatever the game was doing before. */
  step(ticks = 1): void {
    this.paused = true;
    this.stepsOwed += Math.max(0, Math.trunc(ticks));
  }

  /**
   * Called at the end of every logic tick, once the events have run and the dead are cleared.
   *
   * Nothing in the runtime uses this. It is where something watching the game from outside puts
   * itself, so that it sees every tick exactly once: sampling from a render frame sees some
   * ticks twice and misses others, which is no way to watch a value change.
   */
  readonly observers = new Set<(scene: FrameScene) => void>();

  /** Feeds a key press to the next tick, as though it had been typed. */
  pressKey(...keys: Keys[]): void {
    for (const key of keys) this.pressedKeys.add(key);
  }

  /** Feeds a click to the next tick, as though the frame had been clicked on. */
  pressPointer(): void {
    this.pointerPressed = true;
  }

  onPreUpdate(_engine: Engine, elapsed: number): void {
    // Fusion runs its whole loop a fixed number of times per second, and the game's physics is
    // written as per-tick position deltas: the jump adds value("Jump") to Y every tick. Driving
    // that from the render delta makes the player leap much higher on a fast display, so logic
    // is stepped at the application's own frame rate instead.
    const step = 1 / (this.data.manifest.frameRate || 60);

    if (this.paused) {
      // Time spent paused is not owed back: let it pile up and the game answers a pause with a
      // burst of catching up, which is the opposite of what holding it still was for.
      this.tickAccumulator = 0;
      const owed = this.stepsOwed;
      this.stepsOwed = 0;
      for (let i = 0; i < owed; i++) this.tickOnce(step);
    } else {
      this.tickAccumulator =
        Math.min(this.tickAccumulator + elapsed / 1000, step * MAX_CATCHUP_TICKS);
      while (this.tickAccumulator >= step) {
        this.tickAccumulator -= step;
        this.tickOnce(step);
      }
    }

    for (const instance of this.instances) instance.syncPosition();
  }

  /** One turn of Fusion's loop: what moves, then what the events make of it, then the tidying. */
  private tickOnce(step: number): void {
    this.frameTime += step;
    this.ticks++;

    for (const instance of this.instances) {
      if (instance.destroyed) continue;
      if (!instance.hasGraphic) instance.syncGraphic();
      instance.tickAnimation(1);
      // An object playing out its disappearing animation stops where it died: the spark stays
      // on the wall the shot hit rather than carrying on at the shot's speed.
      if (!instance.destroying) updateMovement(instance, this, 1);
    }

    if (this.questionOpen) this.updateQuestionHover();
    else this.interpreter?.run(step);
    // Presses are consumed by the tick that saw them, so one press is one trigger.
    this.pressedKeys.clear();
    this.pointerPressed = false;
    // An animation reports as over, and a movement reports being stopped by the scenery, for
    // the one tick's worth of events that follows.
    for (const instance of this.instances) {
      instance.finishedAnimation = null;
      instance.hitBackground = false;
    }
    this.clearWhatHasLeft();
    this.reapDestroyed();
    for (const observer of this.observers) observer(this);
  }

  /**
   * Brings the camera's drawn position up to where the camera now is.
   *
   * What is on screen, and so what is worth drawing, is judged against where the camera was
   * last drawn, and that is only settled once drawing starts, after this. A camera that has
   * moved this tick is therefore judged against where it was on the last one, and whatever it
   * has just uncovered is left out of the very frame that uncovers it and appears on the next.
   * Slowly that is invisible; at the speed a level scrolls it is a strip of missing scenery
   * down the leading edge of the view. The game moves its own camera from its own events, which
   * have just run, so by here there is nothing left to wait for.
   */
  onPostUpdate(): void {
    this.camera.pos.clone(this.camera.drawPos);
  }

  /**
   * Takes away what has travelled out of the level.
   *
   * Nothing stops an object at the frame's edge, so a shot that misses keeps going, and without
   * this every one of them would still be travelling long after it left the picture. Fusion
   * clears them up the same way, and by the same rule: an object that has moved this tick, and
   * whose own switches do not exempt it, goes as soon as it is far enough out.
   *
   * It goes outright rather than playing out whatever it does when it is destroyed, since there
   * is nobody out there to see it.
   */
  private clearWhatHasLeft(): void {
    for (const instance of this.instances) {
      if (instance.destroyed || instance.destroying) continue;
      const moved = instance.x !== instance.restedAt.x || instance.y !== instance.restedAt.y;
      instance.restedAt.x = instance.x;
      instance.restedAt.y = instance.y;
      if (!moved) continue;
      if (clearedWhenTooFar(instance.def) && tooFarOutside(instance, this)) {
        instance.destroyed = true;
      }
    }
  }

  /** Pointer position in frame coordinates, for mouse-controlled movements. */
  pointerPosition(): { x: number; y: number } | null {
    const pos = this.engine?.input?.pointers?.primary?.lastWorldPos;
    return pos ? { x: pos.x, y: pos.y } : null;
  }

  /** Adds an instance's solid pixels to the obstacle mask, if its object is an obstacle. */
  addObstacle(instance: FusionInstance): void {
    const detail = instance.def.detail;
    const isObstacle =
      (isBackdrop(detail) || isQuickBackdrop(detail)) && detail.obstacleType !== 0;
    if (!isObstacle) return;
    this.paste(instance);
  }

  /** Stamps an instance's current image into the obstacle mask. */
  paste(instance: FusionInstance): void {
    const bounds = instance.bounds();

    // Quick backdrops are solid across their whole box, however they are filled.
    if (isQuickBackdrop(instance.def.detail)) {
      this.obstacles.fillRect(instance.x, instance.y, instance.def.detail.width, instance.def.detail.height);
      return;
    }

    const handle = instance.currentImage();
    if (handle === undefined) return;

    const meta = this.data.images.get(handle);
    const alpha = this.sprites.alphaMap(handle);
    if (!meta) return;

    if (alpha) this.obstacles.stamp(alpha, meta.width, meta.height, bounds.left, bounds.top);
    else this.obstacles.fillRect(bounds.left, bounds.top, meta.width, meta.height);
  }

  /**
   * Recent destructions, newest last. Kept short and only for named objects: when an object
   * vanishes unexpectedly the question is always which event removed it.
   */
  readonly destructionLog: { name: string; event: number; conditions: string[] }[] = [];

  noteDestroyed(instance: FusionInstance, event: { index: number; conditions: { text: string }[] }): void {
    if (!instance.def.name) return;
    this.destructionLog.push({
      name: instance.def.name,
      event: event.index,
      conditions: event.conditions.map((c) => c.text),
    });
    // Keep the earliest entries rather than the most recent: effect cleanup churns constantly,
    // and the interesting question is what removed something during the opening moments.
    if (this.destructionLog.length > 200) this.destructionLog.pop();
  }

  /** Turns on the interpreter's firing diagnostics, which are off during normal play. */
  recordFirings(on = true): void {
    if (this.interpreter) this.interpreter.recordFirings = on;
  }

  /** How many times each event has run its actions; empty unless recording was turned on. */
  get interpreterFirings(): Map<number, number> {
    return this.interpreter?.firings ?? new Map();
  }

  /** The ticks each event ran on, most recent last. */
  get interpreterFiredTicks(): Map<number, number[]> {
    return this.interpreter?.firedTicks ?? new Map();
  }

  /** Reports the given events condition by condition, so a non-firing event can say why. */
  traceEvents(indices: number[]): void {
    this.interpreter?.traced.clear();
    for (const index of indices) this.interpreter?.traced.add(index);
  }

  /** Lines the event trace has collected. */
  get interpreterTrace(): string[] {
    return this.interpreter?.trace ?? [];
  }

  /** Opcodes the interpreter met but does not implement, with hit counts. */
  get interpreterUnsupported(): [string, number][] {
    return [...(this.interpreter?.unsupported ?? new Map())].sort((a, b) => b[1] - a[1]);
  }

  /** The event groups, and whether each is switched on. A group that is off is skipped whole. */
  get eventGroups(): { id: number; active: boolean; events: number[] }[] {
    return this.interpreter?.groups() ?? [];
  }

  /** Switches an event group on or off, as the game's own actions do. */
  setGroupActive(id: number, active: boolean): void {
    this.interpreter?.setGroupActive(id, active);
  }

  /** The frame's event table, as it was dumped. `events` is Excalibur's own. */
  get eventTable(): FrameEvents {
    return this.eventData;
  }

  /** Seconds since the frame started; Fusion timer conditions are expressed against this. */
  get elapsed(): number {
    return this.frameTime;
  }

  /**
   * Every instance of an object that the events can still address.
   *
   * A destroyed instance stays here until the tick's events have finished, and is cleared at the
   * end of the loop. Fusion works the same way, and its games rely on it: the level kills the
   * player and then creates the corpse "at the Gunner" on the next line, so removing it on the
   * spot leaves the create with nowhere to put anything and the player simply vanishes.
   *
   * Collisions are the exception and check for themselves, so nothing collides with a corpse.
   */
  instancesOf(objectId: number): FusionInstance[] {
    return this.byObject.get(objectId) ?? [];
  }

  spawn(objectId: number, x: number, y: number): FusionInstance | null {
    const def = this.data.objects.get(objectId);
    if (!def) return null;

    const instance = new FusionInstance(def, x, y, this.data, this.sprites);
    instance.actor.z = this.instances.length;
    this.instances.push(instance);

    const group = this.byObject.get(objectId);
    if (group) group.push(instance);
    else this.byObject.set(objectId, [instance]);

    this.add(instance.actor);
    return instance;
  }

  private reapDestroyed(): void {
    for (let i = this.instances.length - 1; i >= 0; i--) {
      const instance = this.instances[i];
      if (!instance.destroyed) continue;
      instance.actor.kill();
      this.instances.splice(i, 1);
      const group = this.byObject.get(instance.def.id);
      if (group) {
        const at = group.indexOf(instance);
        if (at >= 0) group.splice(at, 1);
      }
    }
  }

  /**
   * The visible window in frame coordinates. Fusion's "window's edge" conditions measure against
   * this, not against the level, so what counts as off-screen moves with the scrolling.
   */
  windowBounds(): { left: number; top: number; right: number; bottom: number } {
    const halfW = this.data.manifest.windowWidth / 2;
    const halfH = this.data.manifest.windowHeight / 2;
    return {
      left: this.camera.pos.x - halfW,
      top: this.camera.pos.y - halfH,
      right: this.camera.pos.x + halfW,
      bottom: this.camera.pos.y + halfH,
    };
  }

  /** Hands every global object in this frame whatever it was last left holding. */
  private applyGlobals(): void {
    for (const instance of this.instances) this.globals.restore(instance);
  }

  /** Records what this frame's global objects hold, before it is torn down. */
  captureGlobals(): void {
    this.globals.capture(this.instances);
  }

  /** Fusion's "center display at" scrolls the view, clamped to the frame. */
  centreOn(x: number, y: number): void {
    const halfW = this.data.manifest.windowWidth / 2;
    const halfH = this.data.manifest.windowHeight / 2;
    const next = new Vector(
      Math.min(Math.max(x, halfW), Math.max(this.frame.width - halfW, halfW)),
      Math.min(Math.max(y, halfH), Math.max(this.frame.height - halfH, halfH)),
    );

    // An object that does not follow the frame keeps its place on screen, and the runtime does
    // that by carrying its frame coordinates along with the view. Those coordinates are what
    // events see, so this is not only about where it is drawn: a level marks the edges of the
    // visible area with such objects and compares scenery against them, which is how its clouds
    // drift and wrap. Left behind at the level origin they stop meaning anything once the view
    // has moved on.
    const dx = next.x - this.camera.pos.x;
    const dy = next.y - this.camera.pos.y;
    if (dx !== 0 || dy !== 0) {
      for (const instance of this.instances) {
        if (!instance.screenFixed || instance.destroyed) continue;
        instance.x += dx;
        instance.y += dy;
      }
    }

    this.camera.pos = next;
  }
}
