import { Canvas } from 'excalibur';
import type { FontDef, ObjectDef } from '../data/types';
import { isCommon } from '../data/types';
import { cssFont, fontOr } from './fonts';

/**
 * Fusion's Question object.
 *
 * The object holds one paragraph per line: the first is the question, the rest are the answers.
 * "Ask question" carries the point the box is drawn at, and the runtime draws it itself, inside
 * the frame, over whatever the level is showing: a grey panel with the question above a column
 * of raised buttons, each answer in its own. It is not a system dialog, so it scales, scrolls
 * and sits in the picture with everything else; a browser overlay over the canvas is a different
 * thing wearing the page's styling rather than the game's.
 *
 * The measurements are the runtime's: twelve pixels of margin either side, six above each line
 * and six below the last, buttons inset six pixels from the panel's edges and standing two
 * pixels clear of their text above and below.
 */
const X_MARGIN = 12;
const Y_MARGIN = 6;
const BUTTON_INSET = 6;
const BUTTON_PAD = 2;

/** The panel and its raised buttons; the pressed one is drawn sunken. */
const FACE = '#c0c0c0';
const PRESSED_FACE = '#808080';
const EDGE = '#000000';

/**
 * The font a question is written in, which the game names along with the words.
 *
 * Measuring, laying out and drawing all have to agree on it, and a question is laid out once
 * and drawn from that, so it is set as the question is read and holds until the next one.
 */
let font = cssFont(fontOr(undefined));

export interface QuestionItem {
  text: string;
  color: string;
}

interface Line extends QuestionItem {
  /** Distance from the top of the panel to the top of this line's text. */
  top: number;
  height: number;
}

export interface QuestionLayout {
  width: number;
  height: number;
  question: Line;
  answers: Line[];
}

export interface PendingQuestion {
  objectId: number;
  /** Top-left of the panel, in frame coordinates. */
  x: number;
  y: number;
  layout: QuestionLayout;
}

/** Reads an object's paragraphs as a question and its answers, or null if it has none. */
export function questionFor(
  def: ObjectDef,
  fonts: Map<number, FontDef>,
): { question: QuestionItem; answers: QuestionItem[] } | null {
  if (!isCommon(def.detail)) return null;
  const paragraphs = def.detail.paragraphs ?? [];
  if (!paragraphs.length) return null;
  font = cssFont(fontOr(fonts.get(paragraphs[0].font)));
  const items = paragraphs.map((p) => ({ text: p.text, color: p.color }));
  return { question: items[0], answers: items.slice(1) };
}

let measurer: CanvasRenderingContext2D | null | undefined;

function measuringContext(): CanvasRenderingContext2D | null {
  if (measurer === undefined) measurer = document.createElement('canvas').getContext('2d');
  return measurer;
}

function measure(text: string): { width: number; height: number } {
  const context = measuringContext();
  if (!context) return { width: text.length * 7, height: 14 };
  context.font = font;
  const metrics = context.measureText(text);
  const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? 10;
  const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? 3;
  return { width: Math.ceil(metrics.width), height: Math.ceil(ascent + descent) };
}

/**
 * Sizes the panel to its widest line and stacks the lines down it.
 *
 * The panel is as tall as its lines plus a margin above each and one below the last.
 */
export function layOut(question: QuestionItem, answers: QuestionItem[]): QuestionLayout {
  const measured = [question, ...answers].map((item) => ({ item, ...measure(item.text) }));
  const width = Math.max(...measured.map((m) => m.width)) + X_MARGIN * 2;
  const height =
    measured.reduce((total, m) => total + m.height, 0) + Y_MARGIN * (2 + answers.length);

  let top = Y_MARGIN;
  const lines = measured.map((m) => {
    const line: Line = { text: m.item.text, color: m.item.color, top, height: m.height };
    top += m.height + Y_MARGIN;
    return line;
  });

  return { width, height, question: lines[0], answers: lines.slice(1) };
}

/** An answer's button, relative to the panel's top-left. */
export function buttonRect(layout: QuestionLayout, index: number) {
  const line = layout.answers[index];
  return {
    x: BUTTON_INSET,
    y: line.top - BUTTON_PAD,
    width: layout.width - BUTTON_INSET * 2,
    height: line.height + BUTTON_PAD * 2,
  };
}

/** The answer under a point given relative to the panel's top-left, or null. */
export function answerAt(layout: QuestionLayout, x: number, y: number): number | null {
  for (let index = 0; index < layout.answers.length; index++) {
    const box = buttonRect(layout, index);
    if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) return index;
  }
  return null;
}

/** A one-pixel black edge around a filled face, which is how the runtime draws both panel and buttons. */
function drawPanel(
  context: CanvasRenderingContext2D,
  x: number, y: number, width: number, height: number, face: string,
): void {
  context.fillStyle = EDGE;
  context.fillRect(x, y, width, height);
  context.fillStyle = face;
  context.fillRect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2));
}

/**
 * Each line is centred in its own box, across and down, the way the runtime centres its labels.
 * Hanging the text from the top of the box instead leaves it riding high in the button: the
 * baseline a canvas puts under "top" is the top of the em square, not the top of the space the
 * line was measured to occupy.
 */
function drawLine(context: CanvasRenderingContext2D, line: Line, width: number): void {
  context.fillStyle = line.color;
  context.fillText(line.text, width / 2, line.top + line.height / 2);
}

/**
 * The panel as an Excalibur graphic, repainted every frame so the button under the pointer
 * follows it without the scene having to invalidate anything.
 */
export function questionGraphic(
  layout: QuestionLayout,
  state: () => { hovered: number | null; pressed: boolean },
): Canvas {
  return new Canvas({
    width: layout.width,
    height: layout.height,
    cache: false,
    draw: (context) => {
      const { hovered, pressed } = state();
      context.clearRect(0, 0, layout.width, layout.height);
      drawPanel(context, 0, 0, layout.width, layout.height, FACE);

      context.font = font;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      drawLine(context, layout.question, layout.width);

      layout.answers.forEach((line, index) => {
        const box = buttonRect(layout, index);
        const down = pressed && hovered === index;
        drawPanel(context, box.x, box.y, box.width, box.height, down ? PRESSED_FACE : FACE);
        drawLine(context, line, layout.width);
      });
    },
  });
}
