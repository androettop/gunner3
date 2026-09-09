import { DIRECTION_COUNT, type FusionInstance } from './instance';
import type { FrameScene } from './scene';
import { isCommon, type MovementData, type ObjectDef } from '../data/types';

/**
 * Fusion movement engines.
 *
 * Fusion expresses speed, gravity and jump strength on a 0-100 scale evaluated once per game
 * tick. The runtime turns such a value into pixels by multiplying by 1/8, so a shot at speed 80
 * covers 10 pixels a tick, which at this game's 60 fps crosses the 640-pixel window in about a
 * second.
 *
 * Callers pass a delta already measured in game ticks, so the application's declared frame rate
 * decides the pace rather than anything assumed here.
 */
const PIXELS_PER_SPEED_UNIT = 0.125;

/**
 * Acceleration and deceleration are not linear in their 0-100 setting: the runtime looks the
 * setting up in this table to get a change in speed units per tick. The low end is very fine
 * (1/128 of a speed unit) and the top end is effectively instant.
 */
const ACCELERATORS = [
  0.0078125, 0.01171875, 0.015625, 0.0234375, 0.03125, 0.0390625, 0.046875, 0.0625, 0.078125,
  0.09375, 0.1875, 0.21875, 0.25, 0.28125, 0.3125, 0.34375, 0.375, 0.40625, 0.4375, 0.46875,
  0.5625, 0.625, 0.6875, 0.75, 0.8125, 0.875, 0.9375, 1.0, 1.0625, 1.125, 1.25, 1.3125, 1.375,
  1.4375, 1.5, 1.5625, 1.625, 1.6875, 1.75, 1.875, 2.0, 2.125, 2.1875, 2.3125, 2.4375, 2.5,
  2.625, 2.6875, 2.8125, 2.875, 3.0, 3.0625, 3.1875, 3.3125, 3.375, 3.5, 3.625, 3.6875, 3.8125,
  3.875, 4.0, 4.375, 4.75, 5.125, 5.625, 6.0, 6.375, 6.75, 7.125, 7.625, 8.0, 8.75, 9.5, 10.5,
  11.25, 12.0, 12.75, 13.5, 14.5, 15.25, 16.0, 25.5625, 19.1953125, 20.375, 22.390625, 24.0,
  25.59765625, 27.1953125, 28.7734375, 30.390625, 32.0, 38.421875, 45.59375, 52.015625, 58.4375,
  64.859375, 71.28125, 77.703125, 84.0, 100.0, 100.0,
];

/** A 0-100 acceleration setting as a change in speed units per tick. */
function accelerator(value: number): number {
  return value >= 0 && value <= 100 ? ACCELERATORS[value] : value;
}

/**
 * Falling speed is capped, in speed units, before it is converted to pixels. Without the cap a
 * long drop would tunnel straight through the floor.
 */
const MAX_FALL_SPEED = 250;

export const enum MovementType {
  Static = 0,
  Mouse = 1,
  Race = 2,
  Generic = 3,
  Ball = 4,
  Path = 5,
  Platform = 9,
  /**
   * Not one of Fusion's stored types. "Launch object toward <direction> at speed N" gives the
   * object it creates a movement of its own, whatever movement that object is configured with,
   * which for projectiles is almost always Static. Without this a launched shot simply sits
   * wherever it was created.
   */
  Shot = 1000,
}

/** Per-instance movement state, kept beside the definition it came from. */
export interface MovementState {
  type: number;
  definition: Record<string, any>;
  /** Path movement: index of the node being travelled and how far along it we are. */
  node: number;
  travelled: number;
  pauseLeft: number;
  reversing: boolean;
  /**
   * Platform movement: falling speed in Fusion speed units, not pixels. The runtime accumulates
   * it in the same 0-100 scale the settings use and converts to pixels only when it moves.
   */
  fallSpeed: number;
  onGround: boolean;
  /** Set on the first update, when the instance's speed is seeded from the definition. */
  started: boolean;
  /** Set once the path finishes and is not looping. */
  finished: boolean;
}

export function initialState(def: FusionInstance['def']): MovementState | null {
  if (!isCommon(def.detail) || !def.detail.movements.length) return null;
  const movement: MovementData = def.detail.movements[0];
  if (movement.type === MovementType.Static) return null;

  return {
    type: movement.type,
    definition: (movement.definition ?? {}) as Record<string, any>,
    node: 0,
    travelled: 0,
    pauseLeft: 0,
    reversing: false,
    fallSpeed: 0,
    onGround: false,
    started: false,
    finished: false,
  };
}

/** `ticks` is the number of game ticks elapsed, as defined by the application's frame rate. */
/** The movement a launch or shoot action imparts: straight travel along the object's direction. */
export function shotState(speed: number): MovementState {
  return {
    type: MovementType.Shot,
    definition: { Speed: speed },
    node: 0, travelled: 0, pauseLeft: 0, reversing: false,
    fallSpeed: 0, onGround: false, started: true, finished: false,
  };
}

export function update(instance: FusionInstance, scene: FrameScene, ticks: number): void {
  const state = instance.movement;
  if (!state || !instance.moving || instance.destroyed) return;

  switch (state.type) {
    case MovementType.Shot:
      updateShot(instance, state, ticks);
      break;
    case MovementType.Mouse:
      updateMouse(instance, scene);
      break;
    case MovementType.Race:
    case MovementType.Generic:
    case MovementType.Ball:
      // Race and eight-direction both travel along the direction they face; the difference is
      // how the player steers them, which for these is via events rather than a built-in
      // controller. Bouncing off obstacles is shared.
      updateBall(instance, state, scene, ticks);
      break;
    case MovementType.Path:
      updatePath(instance, state, ticks);
      break;
    case MovementType.Platform:
      updatePlatform(instance, state, scene, ticks);
      break;
    default:
      break;
  }
}

/**
 * A launched object travels in a straight line and passes through scenery; Fusion leaves it to
 * the events to notice a collision and destroy it, which is what the game's "shot collides with
 * the background" events do.
 */
function updateShot(instance: FusionInstance, state: MovementState, ticks: number): void {
  const speed = instance.speed || Number(state.definition['Speed'] ?? 0);
  if (speed <= 0) return;
  const step = speed * PIXELS_PER_SPEED_UNIT * ticks;
  const vector = directionVector(instance.direction);
  instance.x += vector.x * step;
  instance.y += vector.y * step;
}

/** Mouse-controlled objects follow the pointer, within the limits the definition sets. */
function updateMouse(instance: FusionInstance, scene: FrameScene): void {
  const pointer = scene.pointerPosition();
  if (!pointer) return;
  instance.x = pointer.x;
  instance.y = pointer.y;
}

/** Direction index to a unit vector. Direction 0 points right, and y grows downwards. */
export function directionVector(direction: number): { x: number; y: number } {
  const angle = (direction / DIRECTION_COUNT) * Math.PI * 2;
  return { x: Math.cos(angle), y: -Math.sin(angle) };
}

/**
 * Ball movement travels along the object's direction and stops dead when it meets an obstacle.
 * It does not rebound by itself: Fusion leaves that to a "bounce" action, which the game fires
 * from a "collides with the background" event.
 */
function updateBall(
  instance: FusionInstance,
  state: MovementState,
  scene: FrameScene,
  ticks: number,
): void {
  if (!state.started) {
    state.started = true;
    // The "moving at start" flag decides whether the object begins at its configured speed.
    if (Number(state.definition['Move'] ?? 0) !== 0) {
      instance.speed = Number(state.definition['Speed'] ?? 0);
    }
  }

  const speed = instance.speed;
  if (speed <= 0) return;

  const vector = directionVector(instance.direction);
  const step = speed * PIXELS_PER_SPEED_UNIT * ticks;
  const { collided } = travel(instance, scene, vector.x * step, vector.y * step);

  if (collided) {
    instance.speed = 0;
    return;
  }

  const decelerate = Number(state.definition['Decelerate'] ?? 0);
  if (decelerate !== 0) {
    instance.speed = Math.max(0, instance.speed - accelerator(decelerate) * ticks);
  }
}

/**
 * The rebound direction the runtime picks after a bounce, indexed by which of the four probes
 * around the object found free space and by the direction it was travelling in.
 */
const REBOUND = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  30, 31, 0, 1, 4, 3, 2, 1, 0, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 24, 25, 26, 27, 27, 28, 28, 28, 28, 29, 29,
  24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 16, 17, 18, 19, 19, 20, 20, 20, 20, 21, 21, 22, 23, 24, 25, 28, 27, 26, 25,
  0, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 20, 21, 22, 22, 23, 24, 24, 24, 24, 25, 26, 27, 28, 29, 30,
  8, 7, 6, 5, 4, 8, 9, 10, 11, 11, 12, 12, 12, 12, 13, 13, 14, 15, 16, 17, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  16, 15, 14, 13, 12, 11, 10, 9, 8, 12, 13, 14, 15, 15, 16, 16, 16, 16, 17, 17, 18, 19, 20, 21, 24, 23, 22, 21, 20, 19, 18, 17,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 23, 22, 21, 20, 19, 18, 17, 16, 17, 18, 19, 20, 21, 22, 23, 24, 23, 22, 21, 20, 19, 18, 17,
  3, 3, 4, 4, 4, 4, 5, 5, 6, 7, 8, 9, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 31, 30, 29, 28, 0, 1, 2,
  0, 0, 1, 1, 2, 3, 4, 5, 8, 7, 6, 5, 4, 3, 2, 1, 0, 31, 30, 29, 28, 27, 26, 25, 24, 28, 29, 30, 31, 31, 0, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  0, 31, 30, 29, 28, 27, 26, 25, 24, 25, 26, 27, 28, 29, 30, 31, 0, 31, 30, 29, 28, 27, 25, 25, 24, 25, 26, 27, 28, 29, 30, 31,
  0, 4, 5, 6, 7, 7, 8, 8, 8, 8, 9, 9, 10, 11, 12, 13, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1,
  16, 15, 14, 13, 12, 11, 10, 9, 8, 9, 10, 11, 12, 13, 14, 15, 16, 15, 14, 13, 12, 11, 10, 9, 8, 9, 10, 11, 12, 13, 14, 15,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
];

/** Ball movement's "angles" setting restricts rebounds to 8, 16 or all 32 directions. */
const ANGLE_MASKS = [0xfffffffc, 0xfffffffe, 0xffffffff];

/**
 * Fusion's bounce: probe eight pixels out at each of the four diagonals, and look the resulting
 * pattern up against the current direction. Reversing 180 degrees instead sends an object that
 * grazed a floor straight back the way it came rather than skimming along it.
 */
export function bounce(instance: FusionInstance, scene: FrameScene): void {
  const state = instance.movement;
  const x = instance.x;
  const y = instance.y;

  let pattern = 0;
  if (!blocked(instance, scene, x - 8, y - 8)) pattern |= 0x01;
  if (!blocked(instance, scene, x + 8, y - 8)) pattern |= 0x02;
  if (!blocked(instance, scene, x + 8, y + 8)) pattern |= 0x04;
  if (!blocked(instance, scene, x - 8, y + 8)) pattern |= 0x08;

  const angles = state ? Number(state.definition['Angles'] ?? 2) : 2;
  const mask = ANGLE_MASKS[Math.min(Math.max(angles, 0), ANGLE_MASKS.length - 1)];

  let direction = REBOUND[pattern * DIRECTION_COUNT + instance.direction] & mask;

  // The table can still point into the obstacle on a slope, so fan out from it until something
  // is clear, widening the search the way the runtime does.
  if (!directionIsFree(instance, scene, direction)) {
    let spread = 4;
    let free = false;
    while (spread <= DIRECTION_COUNT / 2) {
      for (const candidate of [
        (direction - spread + DIRECTION_COUNT) % DIRECTION_COUNT,
        (direction + spread) % DIRECTION_COUNT,
      ]) {
        if (directionIsFree(instance, scene, candidate)) {
          direction = candidate;
          free = true;
          break;
        }
      }
      if (free) break;
      spread += 4;
    }
    if (!free) direction = Math.floor(Math.random() * DIRECTION_COUNT) & mask;
  }

  instance.setDirection(direction & mask);
  // A bounce also restarts an object the collision had stopped.
  if (instance.speed <= 0 && state) {
    instance.speed = Number(state.definition['Speed'] ?? 0);
  }
}

/** True if the object could move eight pixels along this direction without hitting anything. */
function directionIsFree(instance: FusionInstance, scene: FrameScene, direction: number): boolean {
  const vector = directionVector(direction);
  return !blocked(instance, scene, instance.x + vector.x * 8, instance.y + vector.y * 8);
}

/**
 * Move by a whole-pixel path rather than in one jump, so an object stops flush against what it
 * hits instead of tunnelling through a thin wall at speed. Each axis is walked separately, which
 * is what lets an object slide along a surface it is pressed into.
 */
function travel(
  instance: FusionInstance,
  scene: FrameScene,
  addX: number,
  addY: number,
): { collidedX: boolean; collidedY: boolean; collided: boolean } {
  let collidedX = false;
  let collidedY = false;

  if (addX !== 0) {
    const stepX = Math.sign(addX);
    const targetX = instance.x + addX;
    while (Math.abs(targetX - instance.x) >= 1) {
      if (blocked(instance, scene, instance.x + stepX, instance.y)) { collidedX = true; break; }
      instance.x += stepX;
    }
    if (!collidedX && !blocked(instance, scene, targetX, instance.y)) instance.x = targetX;
  }

  if (addY !== 0) {
    const stepY = Math.sign(addY);
    const targetY = instance.y + addY;
    while (Math.abs(targetY - instance.y) >= 1) {
      if (blocked(instance, scene, instance.x, instance.y + stepY)) { collidedY = true; break; }
      instance.y += stepY;
    }
    if (!collidedY && !blocked(instance, scene, instance.x, targetY)) instance.y = targetY;
  }

  // Every stop is the scenery now that the frame's edge is not a wall, and "collides with the
  // background" is read from this for the tick that follows.
  if (collidedX || collidedY) instance.hitBackground = true;

  return { collidedX, collidedY, collided: collidedX || collidedY };
}

function updatePath(instance: FusionInstance, state: MovementState, ticks: number): void {
  const nodes = (state.definition['PathNodes'] ?? []) as Record<string, any>[];
  if (!nodes.length || state.finished) return;

  if (state.pauseLeft > 0) {
    state.pauseLeft -= ticks;
    return;
  }

  const node = nodes[Math.min(state.node, nodes.length - 1)];
  const length = Number(node['Length'] ?? 0);
  const speed = Number(node['Speed'] ?? state.definition['MaximumSpeed'] ?? 0);
  if (speed <= 0) return;

  const step = speed * PIXELS_PER_SPEED_UNIT * ticks;
  const previous = state.travelled;
  state.travelled = Math.min(state.travelled + step, length);

  // Nodes store their whole displacement, so advance proportionally along it.
  const dx = Number(node['Dx'] ?? 0);
  const dy = Number(node['Dy'] ?? 0);
  if (length > 0) {
    const fraction = (state.travelled - previous) / length;
    instance.x += dx * fraction;
    instance.y += dy * fraction;
  }

  if (state.travelled < length) return;

  state.travelled = 0;
  state.pauseLeft = Number(node['Pause'] ?? 0);

  const loop = Number(state.definition['Loop'] ?? 0) !== 0;
  const reverse = Number(state.definition['Reverse'] ?? 0) !== 0;

  if (state.reversing) {
    if (state.node === 0) {
      state.reversing = false;
      if (!loop) state.finished = true;
    } else state.node--;
    return;
  }

  if (state.node + 1 < nodes.length) {
    state.node++;
  } else if (reverse) {
    state.reversing = true;
  } else if (loop) {
    state.node = 0;
  } else {
    state.finished = true;
  }
}

function updatePlatform(
  instance: FusionInstance,
  state: MovementState,
  scene: FrameScene,
  ticks: number,
): void {
  if (!state.started) {
    state.started = true;
    instance.speed = Number(state.definition['Speed'] ?? 0);
  }

  const maxSpeed = Number(state.definition['Speed'] ?? 0);
  const acceleration = accelerator(Number(state.definition['Acceleration'] ?? 0));
  const deceleration = accelerator(Number(state.definition['Deceleration'] ?? 0));

  // With no built-in controller driving it the object coasts: it accelerates up to its
  // configured speed while it has somewhere to go and decelerates once it is stopped.
  instance.speed = Math.min(maxSpeed, instance.speed + acceleration * ticks);

  if (instance.speed > 0) {
    const facingLeft = instance.direction > DIRECTION_COUNT / 4 &&
                       instance.direction < (DIRECTION_COUNT * 3) / 4;
    const step = instance.speed * PIXELS_PER_SPEED_UNIT * ticks;
    const { collidedX } = travel(instance, scene, facingLeft ? -step : step, 0);
    if (collidedX) {
      instance.speed = Math.max(0, instance.speed - deceleration * ticks);
      instance.setDirection(facingLeft ? 0 : DIRECTION_COUNT / 2);
    }
  }

  // Gravity accumulates in Fusion speed units and is capped before it becomes pixels, so a long
  // drop reaches a terminal speed rather than growing without limit.
  const gravity = Number(state.definition['Gravity'] ?? 0);
  state.fallSpeed = Math.min(MAX_FALL_SPEED, state.fallSpeed + gravity * PIXELS_PER_SPEED_UNIT * ticks);

  const fall = state.fallSpeed * PIXELS_PER_SPEED_UNIT * ticks;
  const { collidedY } = travel(instance, scene, 0, fall);

  if (collidedY) {
    state.fallSpeed = 0;
    state.onGround = fall > 0;
  } else {
    state.onGround = false;
  }
}

/** The instance's box as it would be at another position. */
function shiftedBounds(instance: FusionInstance, x: number, y: number) {
  const bounds = instance.bounds();
  const dx = x - instance.x;
  const dy = y - instance.y;
  return {
    left: bounds.left + dx, top: bounds.top + dy,
    right: bounds.right + dx, bottom: bounds.bottom + dy,
  };
}

/**
 * How far outside the frame an object may travel before Fusion takes it away, in pixels.
 *
 * Something has to clear up what leaves the level, or a game that fires a shot a tick would
 * still be holding every one of them an hour later. The distance is a fixed one, and is measured
 * past the object's own size, so an object goes once the whole of it is this far out.
 */
const KILL_BORDER_X = 480;
const KILL_BORDER_Y = 300;

/**
 * Whether objects of this kind are cleared away once they leave the frame.
 *
 * The object's own switches decide it. "Inactivate if too far" asks for it to be put to sleep
 * out there rather than destroyed, and takes precedence; "do not destroy if too far" says to
 * leave it be; and a movement the player steers is never taken out from under them. What is
 * left is the traffic a level throws off, shots and debris and anything launched, which is
 * Fusion's to clear up rather than the game's.
 */
export function clearedWhenTooFar(def: ObjectDef): boolean {
  if (def.typeName !== 'Active' || !isCommon(def.detail)) return false;
  const flags = def.detail.flags;
  if (flags['InactivateIfTooFar'] || flags['DontDestroyIfTooFar']) return false;
  return !def.detail.movements.some((movement) => Number(movement.player ?? 0) !== 0);
}

/** True once the whole of the instance's box is further out than that. */
export function tooFarOutside(instance: FusionInstance, scene: FrameScene): boolean {
  const { left, top, right, bottom } = instance.bounds();
  return right < -KILL_BORDER_X
    || bottom < -KILL_BORDER_Y
    || left > scene.frame.width + KILL_BORDER_X
    || top > scene.frame.height + KILL_BORDER_Y;
}

/**
 * True if the instance's box would overlap an obstacle at this position.
 *
 * The frame's own edge is not one. Nothing in Fusion stops a movement at the border: an object
 * that reaches it carries straight on out of the level, and what happens next is either the
 * game's own doing or the clean-up below. Treating the edge as a wall instead leaves a moving
 * object parked half in and half out, which is neither inside the play area nor far enough
 * outside it for anything to notice, so whatever the game meant to do with it never happens.
 */
function blocked(instance: FusionInstance, scene: FrameScene, x: number, y: number): boolean {
  const { left, top, right, bottom } = shiftedBounds(instance, x, y);
  return scene.obstacles.testRect(left, top, right, bottom);
}
