import {
  Actor, Color, Font, FontStyle, FontUnit, ImageFiltering, Text, Vector,
} from 'excalibur';
import type { GameData } from '../data/loader';
import {
  isBackdrop, isCommon, isQuickBackdrop,
  type CounterData, type DirectionData, type ObjectDef,
} from '../data/types';
import { fontFamily, fontOr } from './fonts';
import type { SpriteStore } from './sprites';
import { initialState, type MovementState } from './movement';

/**
 * Fusion's animation slot for an object being destroyed. An object that defines one plays it out
 * before it is removed.
 */
export const DISAPPEARING_ANIMATION = 4;

/** Fusion's 32 directions, as used by "set direction" and by animation direction slots. */
export const DIRECTION_COUNT = 32;

/**
 * A live object instance.
 *
 * Fusion state (alterable values, flags, animation/direction, movement) lives here rather than
 * in the Excalibur Actor, because the event interpreter reads and writes it directly. The Actor
 * is kept in sync for rendering only.
 */
let nextInstanceId = 1;

export class FusionInstance {
  readonly actor: Actor;
  readonly def: ObjectDef;
  /** Stable identity, used to track which collision pairs are new. */
  readonly id = nextInstanceId++;

  /** Fusion coordinates: origin top-left of the frame, y growing downwards, at the hotspot. */
  x: number;
  y: number;

  direction = 0;
  animation = 0;
  animationFrame = 0;
  animationTimer = 0;
  animationOver = false;
  /** "Stop animation" holds the object on the frame it is showing until it is started again. */
  animationPaused = false;
  /** "Force frame" pins the animation to one frame; null while it runs normally. */
  forcedFrame: number | null = null;
  /** Plays left of a looping animation; refreshed when the animation or direction changes. */
  private loopsLeft = 1;
  /**
   * Where the instance was at the end of the previous tick.
   *
   * The clean-up of what has left the level looks only at what moved, which is how a game may
   * park a spare copy of an object far off the side of a frame and still find it there.
   */
  readonly restedAt: { x: number; y: number };

  /**
   * Set for the tick in which the object's movement was stopped by the scenery.
   *
   * A movement stops flush against what it hits rather than inside it, so the object never
   * overlaps the background and an overlap test alone would never report the contact. Fusion
   * reports it from the movement itself for the same reason.
   */
  hitBackground = false;

  /**
   * The animation that finished on this tick, if any. Fusion reports an animation as over at the
   * moment it ends, before the object falls back to its resting animation, so the signal cannot
   * be recovered afterwards from which animation is playing.
   */
  finishedAnimation: number | null = null;

  visible = true;
  destroyed = false;
  /**
   * Set while the object is playing out its disappearing animation. It is on its way out (it no
   * longer takes part in collisions), but it is still on screen and events can still see it.
   */
  destroying = false;
  /** Index of the event that destroyed this instance, for tracing. */
  destroyedByEvent = -1;
  /** Text objects: which stored paragraph is shown. */
  paragraph = 0;

  /** Pinned to the window rather than the level. */
  readonly screenFixed: boolean;

  /** Drawn with the scenery: a backdrop, or an object that declares itself background. */
  readonly isBackgroundLayer: boolean;

  /** Clamp range for counter objects, null for everything else. */
  readonly counterRange: { initial: number; minimum: number; maximum: number } | null;

  /** Glyph images for a counter that draws its reading as digits, null for anything else. */
  private readonly counterDigits: number[] | null;

  /** The counter itself, for one that draws its reading as a bar. */
  private readonly counterBar: CounterData | null;

  /** Writes the counter reading, honouring its configured range. */
  setCounter(value: number): void {
    const before = this.values[0];
    const range = this.counterRange;
    this.values[0] = range ? Math.min(Math.max(value, range.minimum), range.maximum) : value;
    // A counter that draws its reading has to be redrawn when the reading moves.
    if (this.values[0] !== before && (this.counterDigits || this.counterBar)) this.syncGraphic();
  }

  values: number[];
  strings: string[];
  flags = 0;

  /** Set by "launch"/"shoot" actions and by movement definitions. */
  speed = 0;
  moving = false;

  /** Null for static objects, whose position is driven by events alone. */
  movement: MovementState | null;

  constructor(
    def: ObjectDef,
    x: number,
    y: number,
    private readonly data: GameData,
    private readonly sprites: SpriteStore,
  ) {
    this.def = def;
    this.x = x;
    this.y = y;
    this.restedAt = { x, y };

    const common = isCommon(def.detail) ? def.detail : null;
    this.values = common ? [...common.alterableValues] : [];
    // Counters keep their reading in slot 0 and are clamped to their configured range; the
    // game leans on that for terminal velocity and for the health meter's ceiling.
    this.counterRange = common?.counter ?? null;
    // Display type 1 is "digits"; 2 and 3 are a bar drawn from the counter's own shape.
    const counter = common?.counter;
    this.counterDigits =
      counter?.display === 1 && counter.frames?.length ? counter.frames : null;
    this.counterBar =
      counter && (counter.display === 2 || counter.display === 3) ? counter : null;
    if (this.counterRange) this.values[0] = this.counterRange.initial;
    this.strings = common ? [...common.alterableStrings] : [];
    if (common?.movements.length) this.direction = startingDirection(common.movements[0].startingDirection);

    this.movement = initialState(def);
    // Fusion starts non-static movements running unless an event stops them.
    this.moving = this.movement !== null;

    // Fusion's "visible at start" switch; a handful of objects begin hidden and are revealed by
    // events, and showing them regardless puts stray sprites on screen.
    if (common && common.newFlags && common.newFlags['VisibleAtStart'] === false) this.visible = false;

    // "Follow the frame" disabled pins the object to the window instead of the level, which is
    // how the HUD counters stay put while the level scrolls underneath them. The scene keeps
    // such an object's frame coordinates moving with the view, so it draws in world space like
    // everything else and events still read a position that means something.
    this.screenFixed = common?.flags?.['DontFollowFrame'] === true;
    // Only the scenery draws in the background band. NebulaFD calls object flag 12
    // "DisplayAsBackground", but the same bit is "quick display" in the other reader of this
    // format: a drawing hint, not a layer. Taking it as a layer sends the HUD counters and the
    // weapon label behind the panels they are meant to sit on.
    this.isBackgroundLayer =
      def.typeName === 'Backdrop' || def.typeName === 'QuickBackdrop' ||
      common?.flags?.['Background'] === true;

    this.actor = new Actor({ x, y, name: def.name || def.typeName });
    this.actor.z = 0;
    this.syncGraphic();
  }

  /** Image handles this instance can ever show, so the scene can preload them. */
  static imageHandles(def: ObjectDef): number[] {
    if (isBackdrop(def.detail)) return [def.detail.image];
    if (isQuickBackdrop(def.detail)) return def.detail.image >= 0 ? [def.detail.image] : [];
    if (!isCommon(def.detail)) return [];

    const handles: number[] = [];
    for (const animation of def.detail.animations)
      for (const direction of animation.directions) handles.push(...direction.frames);
    // A counter drawn as digits has no animation at all; its glyphs live in the counter data.
    handles.push(...(def.detail.counter?.frames ?? []));
    return handles;
  }

  /** Frames of the current animation for the direction closest to the one we face. */
  private currentFrames(): number[] {
    if (isBackdrop(this.def.detail)) return [this.def.detail.image];
    if (isQuickBackdrop(this.def.detail)) return this.def.detail.image >= 0 ? [this.def.detail.image] : [];
    if (!isCommon(this.def.detail)) return [];

    const animation =
      this.def.detail.animations.find((a) => a.id === this.animation) ?? this.def.detail.animations[0];
    if (!animation || !animation.directions.length) return [];

    return (nearestDirection(animation.directions, this.direction) ?? animation.directions[0]).frames;
  }

  private currentDirectionData() {
    if (!isCommon(this.def.detail)) return null;
    const animation =
      this.def.detail.animations.find((a) => a.id === this.animation) ?? this.def.detail.animations[0];
    if (!animation || !animation.directions.length) return null;
    return nearestDirection(animation.directions, this.direction) ?? animation.directions[0];
  }

  /**
   * A one-shot animation hands the object back to its default when it finishes.
   *
   * Fusion reverts to the object's resting animation rather than holding the last frame, which
   * is what makes "animation N is playing" go false again afterwards.
   */
  private revertToDefaultAnimation(): void {
    if (!isCommon(this.def.detail)) return;
    const first = this.def.detail.animations[0];
    if (!first || first.id === this.animation) return;
    this.setAnimation(first.id);
  }

  /** Text objects re-render when the displayed paragraph changes. */
  setParagraph(index: number): void {
    if (this.paragraph === index && this.overriddenText === null) return;
    this.overriddenText = null;
    this.paragraph = index;
    this.renderedParagraph = null;
    this.syncGraphic();
  }

  /** Text set by an event, which stands in for the paragraph the object was built with. */
  private overriddenText: string | null = null;

  /** The text a text object is currently showing, for the expression that reads it. */
  currentText(): string {
    if (this.overriddenText !== null) return this.overriddenText;
    const detail = this.def.detail;
    if (!detail || !('paragraphs' in detail)) return '';
    const paragraphs = detail.paragraphs;
    if (!paragraphs.length) return '';
    return paragraphs[Math.min(this.paragraph, paragraphs.length - 1)]?.text ?? '';
  }

  /** A colour set by an event, over the one the paragraph carries. */
  private overriddenTextColor: string | null = null;

  /** "Set the text colour": what the object is drawn in from now on. */
  setTextColor(color: string): void {
    if (this.overriddenTextColor === color) return;
    this.overriddenTextColor = color;
    this.renderedParagraph = null;
    this.syncGraphic();
  }

  /** "Set the text": what the object shows from now on, whatever paragraph it was built with. */
  setText(value: string): void {
    if (this.overriddenText === value) return;
    this.overriddenText = value;
    this.renderedParagraph = null;
    this.syncGraphic();
  }

  /**
   * Holds the animation on one frame, or lets it run again.
   *
   * The frame is applied straight away rather than at the next animation step, since the point
   * of forcing one is to show it now.
   */
  forceAnimationFrame(frame: number | null): void {
    this.forcedFrame = frame;
    if (frame !== null) this.animationFrame = frame;
    this.syncGraphic();
  }

  /** True when the object defines this animation slot at all. */
  hasAnimation(id: number): boolean {
    return isCommon(this.def.detail) && this.def.detail.animations.some((a) => a.id === id);
  }

  setAnimation(id: number): void {
    if (this.animation === id) return;
    // Starting an animation cancels the "that animation is over" signal, because it is no longer
    // over: it is running again from its first frame. Starting a *different* one leaves the
    // signal alone: it still describes what finished this tick.
    //
    // Both halves are load-bearing. Two events react to the enemy arm's firing animation ending,
    // one restarting it and one dropping the arm to idle; without the first half the second undid
    // the first, the "not already firing" gate stayed open and the enemy fired a third shot. And
    // the player's slide ends with the walking animation being set by an earlier event than the
    // one that watches for the slide finishing, so without the second half the signal was wiped
    // before that event ever saw it and the arm the slide hides was never brought back.
    if (this.finishedAnimation === id) this.finishedAnimation = null;
    this.animation = id;
    this.animationFrame = 0;
    this.animationTimer = 0;
    this.animationOver = false;
    this.loopsLeft = this.currentDirectionData()?.repeat ?? 1;
    this.syncGraphic();
  }

  setDirection(direction: number): void {
    const wrapped = ((direction % DIRECTION_COUNT) + DIRECTION_COUNT) % DIRECTION_COUNT;
    if (this.direction === wrapped) return;
    this.direction = wrapped;
    this.loopsLeft = this.currentDirectionData()?.repeat ?? 1;
    this.syncGraphic();
  }

  /**
   * Advances the animation, given how many game ticks have passed.
   *
   * Fusion counts an animation's speed up at that rate and moves on one frame each time the
   * count passes 100, so a frame is never skipped however fast the animation is set. Advancing
   * by the elapsed amount instead steps over frames, and a level that watches for a particular
   * frame then waits for one that never comes. The laser trail is destroyed on reaching its
   * eighth frame, and at speed 100 it went 0, 2, 4, 6 and round again, so it never left.
   */
  tickAnimation(ticks: number): void {
    if (this.animationPaused || this.forcedFrame !== null) return;
    const direction = this.currentDirectionData();
    const frames = this.currentFrames();
    if (!direction || frames.length <= 1) return;

    this.animationTimer += this.animationSpeed(direction) * ticks;

    let moved = false;
    while (this.animationTimer > 100 && !this.animationOver) {
      this.animationTimer -= 100;
      this.step(direction, frames);
      moved = true;
    }
    if (moved) this.syncGraphic();
  }

  /**
   * How fast a direction animates.
   *
   * A direction stores a speed range rather than a speed. When the two ends are equal (759 of
   * this game's 760 directions), that is the speed. When they differ the runtime reads it off
   * how fast the object is moving, scaled across the movement's own speed range, and an object
   * whose movement has no range at all sits at the middle of the animation's. Taking the top of
   * the range instead ran the one direction that differs, the player's arm firing along
   * direction 13, at 50 where the runtime gives it 42.
   *
   * The arithmetic is the runtime's, integer throughout, so the middle of 35..50 is 42 and not
   * 42.5.
   */
  /**
   * A speed set by an event, which stands in for the one the animation was built with. Null
   * while the object animates at its own pace.
   */
  animationSpeedOverride: number | null = null;

  private animationSpeed(direction: DirectionData): number {
    if (this.animationSpeedOverride !== null) return this.animationSpeedOverride;
    const delta = direction.maxSpeed - direction.minSpeed;
    if (delta === 0) return direction.minSpeed;

    const definition = this.movement?.definition ?? {};
    const range = Number(definition['MaximumSpeed'] ?? 0) - Number(definition['MinimumSpeed'] ?? 0);
    if (range <= 0) return direction.minSpeed + Math.trunc(delta / 2);

    return Math.min(
      direction.maxSpeed,
      direction.minSpeed + Math.trunc((delta * this.speed) / range),
    );
  }

  /** One frame on, handling the end of the animation. */
  private step(direction: DirectionData, frames: number[]): void {
    if (this.animationFrame + 1 <= frames.length - 1) {
      this.animationFrame++;
      return;
    }

    // Repeat is a loop count: zero loops for ever, anything else plays that many times and then
    // stops. A disappearing animation always plays once whatever its setting says, since the
    // object is waiting on it to finish before it can go.
    const loops = direction.repeat === 0 && !this.destroying ? Infinity : direction.repeat;
    if (this.loopsLeft > 1 || loops === Infinity) {
      if (loops !== Infinity) this.loopsLeft--;
      this.animationFrame = Math.min(direction.repeatFrame, frames.length - 1);
      return;
    }

    this.animationOver = true;
    this.animationFrame = frames.length - 1;
    const finished = this.animation;
    // The end of the disappearing animation is when the object actually goes.
    if (this.destroying && this.animation === DISAPPEARING_ANIMATION) this.destroyed = true;
    else this.revertToDefaultAnimation();
    // Recorded after the fallback, which is itself an animation change.
    this.finishedAnimation = finished;
  }

  /**
   * How solid the object is drawn: 1 for solid, 0 for invisible.
   *
   * Fusion calls it semi-transparency and counts it the other way round, from 0 to 128; the
   * action that sets it does that conversion, so what is kept here is an ordinary opacity.
   */
  get opacity(): number {
    return this.actor.graphics.opacity;
  }

  set opacity(value: number) {
    this.actor.graphics.opacity = Math.min(Math.max(value, 0), 1);
  }

  /** True once a sprite has been applied; false while its image is still loading. */
  hasGraphic = false;

  syncGraphic(): boolean {
    // Text objects have no images: they draw one of their stored paragraphs.
    if (this.def.typeName === 'Text') return this.syncText();

    // A counter set to show digits draws its reading rather than a sprite of its own.
    if (this.counterDigits) return this.syncDigits(this.counterDigits);
    if (this.counterBar) return this.syncBar(this.counterBar);

    // Quick backdrops are a colour ramp or a tiled image sized to the object's own box, not a
    // plain sprite drawn at its image's natural size.
    if (isQuickBackdrop(this.def.detail)) {
      const sprite = this.sprites.quickBackdrop(this.def.id, this.def.detail);
      if (!sprite) return false;
      this.actor.graphics.use(sprite);
      this.actor.graphics.offset = new Vector(this.def.detail.width / 2, this.def.detail.height / 2);
      this.actor.graphics.visible = this.visible;
      this.hasGraphic = true;
      return true;
    }

    const frames = this.currentFrames();
    const frame = this.forcedFrame ?? this.animationFrame;
    const handle = frames[Math.min(Math.max(frame, 0), frames.length - 1)];
    if (handle === undefined) return false;

    const sprite = this.sprites.sprite(handle);
    if (!sprite) return false;

    this.actor.graphics.use(sprite);
    const offset = this.sprites.centreOffset(handle, isBackdrop(this.def.detail));
    this.actor.graphics.offset = new Vector(offset.x, offset.y);
    this.actor.graphics.visible = this.visible;
    this.hasGraphic = true;
    return true;
  }

  /**
   * Draws a counter's reading as a row of glyph images.
   *
   * The glyphs are the counter's own, in the order 0-9 then `-`, `+`, `.`, `e`. Fusion puts the
   * object's hotspot at the bottom right of the row, so the number grows leftwards and upwards
   * from where the instance sits, which is what lines a reading up against the label beside it.
   */
  private syncDigits(frames: number[]): boolean {
    const text = String(Math.trunc(this.values[0] ?? 0));
    const sprite = this.sprites.digitRow(frames, text);
    if (!sprite) return false;

    if (this.renderedDigits !== text) {
      this.renderedDigits = text;
      this.actor.graphics.use(sprite);
      // The hotspot sits at the bottom right of the row, so the number grows leftwards and
      // upwards from where the instance sits, which lines a reading up against its label.
      this.actor.graphics.offset = new Vector(-sprite.width / 2, -sprite.height / 2);
    }

    this.actor.graphics.visible = this.visible;
    this.hasGraphic = true;
    return true;
  }

  private renderedDigits: string | null = null;

  /**
   * Draws a counter's reading as a bar.
   *
   * Fusion puts a bar where the object sits, drawn down and to the right of it, which is the
   * corner it is laid out from in the frame. The reading decides how much of the box is full,
   * and the bar is rebuilt only when that changes.
   */
  private syncBar(counter: CounterData): boolean {
    const span = counter.maximum - counter.minimum;
    const reading = this.values[0] ?? 0;
    const part = span > 0 ? (reading - counter.minimum) / span : 0;
    // A bar is a box a few hundred pixels wide, so a thousandth of it is under a pixel: anything
    // finer than that is the same picture and not worth building again.
    const shown = String(Math.round(Math.max(0, Math.min(1, part)) * 1000));

    if (this.renderedBar !== shown) {
      const graphic = this.sprites.counterBar(this.def.id, counter, part);
      if (!graphic) return false;
      this.renderedBar = shown;
      this.actor.graphics.use(graphic);
      // Laid out from its top left, like a backdrop, rather than around its middle.
      this.actor.graphics.offset = Vector.Zero;
    }

    this.actor.graphics.visible = this.visible;
    this.hasGraphic = true;
    return true;
  }

  private renderedBar: string | null = null;

  /** Draws the selected paragraph, laid out from the object's top-left like Fusion does. */
  private syncText(): boolean {
    if (!isCommon(this.def.detail)) return false;
    const paragraphs = this.def.detail.paragraphs ?? [];
    const paragraph = paragraphs[Math.min(this.paragraph, paragraphs.length - 1)];
    if (!paragraph) return false;
    const shown = this.overriddenText ?? paragraph.text;

    if (this.renderedParagraph !== shown) {
      this.renderedParagraph = shown;
      // The paragraph names one of the game's own fonts, which is a face and a size rather
      // than any letters: what the machine makes of that name is what the text is written in.
      const font = fontOr(this.data.fonts.get(paragraph.font));
      const text = new Text({
        text: shown,
        color: Color.fromHex(this.overriddenTextColor ?? paragraph.color),
        font: new Font({
          family: fontFamily(font),
          size: font.size,
          unit: FontUnit.Px,
          bold: font.weight >= 700,
          style: font.italic ? FontStyle.Italic : FontStyle.Normal,
          // A face drawn in whole pixels is spoiled by being smoothed into place.
          filtering: ImageFiltering.Pixel,
        }),
      });
      this.actor.graphics.use(text);
      this.actor.graphics.offset = new Vector(text.width / 2, text.height / 2);
    }

    this.actor.graphics.visible = this.visible;
    this.hasGraphic = true;
    return true;
  }

  private renderedParagraph: string | null = null;

  syncPosition(): void {
    this.actor.pos.x = this.x;
    this.actor.pos.y = this.y;
    this.actor.graphics.visible = this.visible && !this.destroyed;
  }

  /**
   * The image's action point in frame coordinates.
   *
   * Fusion offsets "set position at (x,y) from <object>" from the parent's action point when
   * the parameter says so, which in this game is every parented position there is. Using the
   * hotspot instead misplaces the player's arm and all the small probe objects the events rely
   * on for collision, so it shows up as bad hit detection rather than as a visible offset.
   */
  actionPoint(): { x: number; y: number } {
    const handle = this.currentImage();
    const meta = handle === undefined ? undefined : this.data.images.get(handle);
    if (!meta) return { x: this.x, y: this.y };
    return {
      x: this.x - meta.hotspotX + meta.actionPointX,
      y: this.y - meta.hotspotY + meta.actionPointY,
    };
  }

  /** Handle of the image currently displayed, if any. */
  currentImage(): number | undefined {
    const frames = this.currentFrames();
    return frames[Math.min(this.animationFrame, frames.length - 1)];
  }

  /** Bounding box in frame coordinates, from the current image's size and hotspot. */
  bounds(): { left: number; top: number; right: number; bottom: number } {
    // A bar counter's box is the size it declares, laid out from where the object sits.
    if (this.counterBar) {
      return {
        left: this.x,
        top: this.y,
        right: this.x + (this.counterBar.width ?? 0),
        bottom: this.y + (this.counterBar.height ?? 0),
      };
    }

    // A quick backdrop's box is its declared size, which is what it is stretched or tiled to.
    if (isQuickBackdrop(this.def.detail)) {
      return {
        left: this.x,
        top: this.y,
        right: this.x + this.def.detail.width,
        bottom: this.y + this.def.detail.height,
      };
    }

    // Text carries no image, and its box is the rectangle it was laid out in. Without this it
    // has no extent at all, and a text object the game expects to be clicked cannot be hit: the
    // options screen is a column of them, and every setting on it was unreachable.
    const text = this.def.typeName === 'Text' ? textSizeOf(this.def.detail) : null;
    if (text) {
      return {
        left: this.x,
        top: this.y,
        right: this.x + text.width,
        bottom: this.y + text.height,
      };
    }

    const handle = this.currentImage();
    const meta = handle === undefined ? undefined : this.data.images.get(handle);
    if (!meta) return { left: this.x, top: this.y, right: this.x, bottom: this.y };

    // A backdrop's stored position is the top-left of its image; only active objects are
    // placed by their hotspot. Several of this level's trees carry a hotspot equal to the
    // image width, so treating them like actives shifted them a full image to the left.
    const backdrop = isBackdrop(this.def.detail);
    const left = backdrop ? this.x : this.x - meta.hotspotX;
    const top = backdrop ? this.y : this.y - meta.hotspotY;
    return { left, top, right: left + meta.width, bottom: top + meta.height };
  }

  /**
   * Begin destruction, and report whether the object is gone already.
   *
   * An object with a disappearing animation is not removed on the spot: it plays that animation
   * through and vanishes when it ends. That animation is the effect (a bullet's spark against a
   * wall, a barrel's explosion), and the game hangs its own events off it playing, which is how a
   * barrel throws out burning debris as it goes up.
   */
  beginDestroy(): boolean {
    if (this.destroyed) return true;
    if (this.destroying) return false;
    if (!this.hasAnimation(DISAPPEARING_ANIMATION)) {
      this.destroyed = true;
      return true;
    }
    this.destroying = true;
    this.setAnimation(DISAPPEARING_ANIMATION);
    return false;
  }

  overlaps(other: FusionInstance): boolean {
    // Something on its way out no longer collides, so a dying shot cannot wound twice.
    if (this.destroyed || other.destroyed || this.destroying || other.destroying) return false;
    const a = this.bounds();
    const b = other.bounds();
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  }
}

/**
 * The declared direction closest to the one being faced, going the short way round the circle.
 *
 * Animations rarely declare all 32 directions: the enemies' sight cones declare only 0 and 16,
 * one leaning left and one right. Falling back to the first declared direction instead of the
 * nearest pointed every cone rightwards regardless of which way its owner faced, so enemies
 * facing away still spotted the player.
 */
function nearestDirection(directions: DirectionData[], wanted: number): DirectionData | undefined {
  // Fusion walks outwards from the direction asked for, one step at a time in each sense, and
  // takes whichever it reaches first; on a tie it takes the one going up. Objects here define
  // two or six of the thirty-two directions, so ties are ordinary rather than rare: an enemy
  // whose animation has only directions 2 and 14 and who is told to look straight up is exactly
  // half way between them. Breaking the tie by whichever happens to be stored first turns that
  // into whichever way the sprite sheet was authored.
  let ahead: DirectionData | undefined;
  let aheadDistance = DIRECTION_COUNT;
  let behind: DirectionData | undefined;
  let behindDistance = DIRECTION_COUNT;

  for (const direction of directions) {
    if (!direction.frames.length) continue;
    const up = (((direction.index - wanted) % DIRECTION_COUNT) + DIRECTION_COUNT) % DIRECTION_COUNT;
    const down = (((wanted - direction.index) % DIRECTION_COUNT) + DIRECTION_COUNT) % DIRECTION_COUNT;
    if (up < aheadDistance) { aheadDistance = up; ahead = direction; }
    if (down < behindDistance) { behindDistance = down; behind = direction; }
  }

  // An exact match sits at distance zero both ways and comes back from either.
  return behindDistance < aheadDistance ? behind : ahead;
}

/**
 * Movement chunks store the starting direction as a 32-bit mask with one bit per Fusion
 * direction; the runtime picks one of the set bits. We take the lowest.
 */
function startingDirection(mask: number): number {
  if (!mask) return 0;
  for (let bit = 0; bit < DIRECTION_COUNT; bit++) if (mask & (1 << bit)) return bit;
  return 0;
}

/**
 * The rectangle a text object occupies, or nothing for anything that draws an image instead.
 *
 * Only Text objects are laid out this way; a size of zero means the object was never given one
 * and is treated as having no box, rather than as a box of nothing.
 */
function textSizeOf(detail: ObjectDef['detail']): { width: number; height: number } | null {
  if (!isCommon(detail)) return null;
  const size = detail.textSize;
  if (!size || (!size.width && !size.height)) return null;
  return size;
}
