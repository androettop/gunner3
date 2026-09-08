/**
 * Standard MIDI File parser.
 *
 * The game's music bank is 15 SMF files. Browsers cannot play MIDI natively and shipping a
 * General MIDI soundfont would dwarf the rest of the assets, so the files are parsed here into
 * plain note events and synthesised in player.ts.
 */

export interface Note {
  /** Seconds from the start of the track. */
  start: number;
  duration: number;
  /** MIDI note number, 0-127. */
  pitch: number;
  velocity: number;
  channel: number;
  /** Program (instrument) selected on the channel when the note started. */
  program: number;
}

export interface MidiFile {
  notes: Note[];
  duration: number;
}

interface RawEvent {
  tick: number;
  kind: 'on' | 'off' | 'tempo' | 'program';
  a: number;
  b: number;
  channel: number;
}

export function parseMidi(buffer: ArrayBuffer): MidiFile {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  if (readTag(bytes, 0) !== 'MThd') throw new Error('Not a MIDI file');
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const division = view.getUint16(12);

  if (division & 0x8000) throw new Error('SMPTE time division is not supported');
  const ticksPerBeat = division;

  // Collect every track's events on a shared tick timeline, then convert to seconds once the
  // tempo map is known. Format 1 keeps tempo in track 0 but notes in the others.
  const events: RawEvent[] = [];
  let offset = 8 + view.getUint32(4);

  for (let track = 0; track < trackCount; track++) {
    if (offset + 8 > bytes.length || readTag(bytes, offset) !== 'MTrk') break;
    const end = offset + 8 + view.getUint32(offset + 4);
    let cursor = offset + 8;
    let tick = 0;
    let runningStatus = 0;

    while (cursor < end && cursor < bytes.length) {
      const delta = readVarInt(bytes, cursor);
      cursor = delta.next;
      tick += delta.value;

      let status = bytes[cursor];
      if (status & 0x80) cursor++;
      else status = runningStatus; // Running status: reuse the previous channel message.
      if ((status & 0x80) !== 0 && status < 0xf0) runningStatus = status;

      const type = status & 0xf0;
      const channel = status & 0x0f;

      if (status === 0xff) {
        const metaType = bytes[cursor++];
        const metaLen = readVarInt(bytes, cursor);
        cursor = metaLen.next;
        if (metaType === 0x51 && metaLen.value === 3) {
          const usPerBeat = (bytes[cursor] << 16) | (bytes[cursor + 1] << 8) | bytes[cursor + 2];
          events.push({ tick, kind: 'tempo', a: usPerBeat, b: 0, channel: 0 });
        }
        cursor += metaLen.value;
      } else if (status === 0xf0 || status === 0xf7) {
        const sysexLen = readVarInt(bytes, cursor);
        cursor = sysexLen.next + sysexLen.value;
      } else if (type === 0x90 || type === 0x80) {
        const pitch = bytes[cursor++];
        const velocity = bytes[cursor++];
        // A note-on with zero velocity is a note-off.
        events.push({ tick, kind: type === 0x90 && velocity > 0 ? 'on' : 'off', a: pitch, b: velocity, channel });
      } else if (type === 0xc0 || type === 0xd0) {
        events.push({ tick, kind: 'program', a: bytes[cursor++], b: 0, channel });
      } else {
        cursor += 2;
      }
    }

    offset = end;
    if (format === 0) break;
  }

  events.sort((a, b) => a.tick - b.tick);
  return toNotes(events, ticksPerBeat);
}

function toNotes(events: RawEvent[], ticksPerBeat: number): MidiFile {
  const notes: Note[] = [];
  const open = new Map<string, Note>();
  const programs = new Array<number>(16).fill(0);

  let usPerBeat = 500000; // 120 bpm, the MIDI default
  let lastTick = 0;
  let seconds = 0;

  for (const event of events) {
    seconds += ((event.tick - lastTick) / ticksPerBeat) * (usPerBeat / 1_000_000);
    lastTick = event.tick;

    if (event.kind === 'tempo') {
      usPerBeat = event.a || usPerBeat;
      continue;
    }
    if (event.kind === 'program') {
      programs[event.channel] = event.a;
      continue;
    }

    const key = `${event.channel}:${event.a}`;
    if (event.kind === 'on') {
      const note: Note = {
        start: seconds,
        duration: 0,
        pitch: event.a,
        velocity: event.b,
        channel: event.channel,
        program: programs[event.channel],
      };
      open.set(key, note);
      notes.push(note);
    } else {
      const note = open.get(key);
      if (note) {
        note.duration = Math.max(seconds - note.start, 0.02);
        open.delete(key);
      }
    }
  }

  // Anything still held when the file ends gets a short tail.
  for (const note of open.values()) note.duration = Math.max(seconds - note.start, 0.05);

  return { notes, duration: seconds };
}

function readTag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function readVarInt(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let cursor = at;
  for (let i = 0; i < 4; i++) {
    const byte = bytes[cursor++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: cursor };
}
