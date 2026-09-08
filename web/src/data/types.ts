/** Shapes of the JSON produced by tools/WebDump. */

export interface ImageMeta {
  handle: number;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  actionPointX: number;
  actionPointY: number;
  graphicMode: number;
}

export interface DirectionData {
  index: number;
  minSpeed: number;
  maxSpeed: number;
  repeat: number;
  repeatFrame: number;
  frames: number[];
}

export interface AnimationData {
  id: number;
  name: string;
  directions: DirectionData[];
}

export interface MovementData {
  name: string;
  id: number;
  player: number;
  type: number;
  startingDirection: number;
  definition: Record<string, unknown> | null;
}

export interface ParagraphData {
  text: string;
  color: string;
  font: number;
}

export type FlagMap = Record<string, boolean>;

export interface CommonDetail {
  /** Display and behaviour switches from the object's common chunk. */
  flags: FlagMap;
  newFlags: FlagMap;
  preferences: FlagMap;
  animations: AnimationData[];
  /** Strings shown by Text objects and offered by Question objects. */
  paragraphs: ParagraphData[];
  movements: MovementData[];
  alterableValues: number[];
  /**
   * Counter reading, its clamp range, and how it draws itself. Counters do not use the alterable
   * values. `display` is 0 hidden, 1 digits, 2 vertical bar, 3 horizontal bar, 4 animation,
   * 5 text; `frames` names one image per glyph, in the order 0-9 then `-`, `+`, `.`, `e`.
   */
  counter: {
    initial: number;
    minimum: number;
    maximum: number;
    display?: number;
    width?: number;
    height?: number;
    frames?: number[];
  };
  alterableStrings: string[];
  identifier: string;
  backColor: string;
}

export interface BackdropDetail {
  image: number;
  width: number;
  height: number;
  obstacleType: number;
  collisionType: number;
}

export interface QuickBackdropDetail extends Omit<BackdropDetail, 'image'> {
  shape: number;
  image: number;
  fillType: number;
  color1: string;
  color2: string;
  /** A gradient runs down the object when set, across it when not. */
  verticalGradient: boolean;
  borderSize: number;
  borderColor: string;
}

export type ObjectTypeName =
  | 'QuickBackdrop' | 'Backdrop' | 'Active' | 'Text' | 'Question'
  | 'Score' | 'Lives' | 'Counter' | 'RTF' | 'SubApplication' | 'Extension';

export interface ObjectDef {
  id: number;
  handle: number;
  name: string;
  type: number;
  typeName: ObjectTypeName | string;
  inkEffect: number;
  inkEffectParam?: number;
  blendCoeff?: number;
  headerFlags?: FlagMap;
  inkFlags?: FlagMap;
  detail: CommonDetail | BackdropDetail | QuickBackdropDetail | null;
}

export interface InstanceDef {
  handle: number;
  objectInfo: number;
  x: number;
  y: number;
  layer: number;
  parentType: number;
  parentHandle: number;
  /** "CreateOnly" marks a template that only exists for Create actions to copy. */
  flags: FlagMap;
}

export interface LayerDef {
  name: string;
  xCoefficient: number;
  yCoefficient: number;
}

export interface FrameDef {
  index: number;
  name: string;
  width: number;
  height: number;
  background: string;
  layers: LayerDef[];
  instances: InstanceDef[];
  eventCount: number;
  events: string;
}

export interface SoundDef {
  handle: number;
  name: string;
  file: string;
  format: string;
  frequency: number;
}

export interface MusicDef {
  handle: number;
  name: string;
  file: string;
  frequency: number;
}

export interface GameManifest {
  appName: string;
  author: string;
  copyright: string;
  engine: string;
  runtimeVersion: string;
  productBuild: number;
  windowWidth: number;
  windowHeight: number;
  frameRate: number;
  /** "Jump to frame" stores an index into this table, not a frame index. */
  frameHandles: number[];
  globalValues: number[];
  globalStrings: string[];
  frames: FrameDef[];
  objects: ObjectDef[];
  sounds: SoundDef[];
  music: MusicDef[];
  images: ImageMeta[];
}

/** One condition or action inside an event. */
export interface AceDef {
  objectType: number;
  num: number;
  objectInfo: number;
  objectInfoList: number;
  /** Inverts the condition. 13% of this game's conditions are negated. */
  negated?: boolean;
  /** False marks a triggered condition: it fires on its event, not every tick. */
  always?: boolean;
  repeat?: boolean;
  text: string;
  parameters: ParamDef[];
}

export interface ParamDef {
  code: number;
  type: string | null;
  value: string;
  /** Reflection dump of the parameter chunk; field names match NebulaFD's classes. */
  data: Record<string, any> | null;
}

export interface EventDef {
  index: number;
  conditions: AceDef[];
  actions: AceDef[];
}

export interface EventObjectDef {
  handle: number;
  name: string;
  objectType: number;
  itemType: number;
  itemHandle: number;
}

export interface FrameEvents {
  frame: number;
  name: string;
  eventObjects: EventObjectDef[];
  events: EventDef[];
}

export function isCommon(d: ObjectDef['detail']): d is CommonDetail {
  return !!d && 'animations' in d;
}

export function isBackdrop(d: ObjectDef['detail']): d is BackdropDetail {
  return !!d && 'image' in d && !('shape' in d);
}

export function isQuickBackdrop(d: ObjectDef['detail']): d is QuickBackdropDetail {
  return !!d && 'shape' in d;
}
