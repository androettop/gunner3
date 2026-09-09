/**
 * Backing store for Clickteam's INI extension.
 *
 * Each INI object holds its own current file, group and item, set by separate actions, and reads
 * or writes a value against that triple. There is no save action: a write goes straight to the
 * file, which is how a title saves a slot without a flush step.
 *
 * The cursors are per object and the files are shared. A level that reads its progress through
 * one INI object while reading its weapons through another relies on both: the two keep separate
 * places in the file, and a write through either is visible to the other.
 *
 * localStorage stands in for the file system, one entry per INI file holding the whole file as
 * JSON: the same shape the file has, groups of named items:
 *
 *   fusion:ini:c:/gunner3.ini  ->  {"Save Slot 1": {"Level": "4", "Gun2": "1"}}
 *
 * Values are kept as the strings an INI file would hold and converted when read, so a slot
 * written as text and read as a number behaves the way it does on disk.
 */
type IniFile = Record<string, Record<string, string>>;

interface Cursor {
  file: string;
  group: string;
  item: string;
}

const PREFIX = 'fusion:ini:';

export class IniStore {
  /** Where each INI object is currently pointed. */
  private readonly cursors = new Map<number, Cursor>();

  /** Parsed files, so a run of reads does not re-parse the same entry each time. */
  private readonly files = new Map<string, IniFile>();

  /**
   * What the game shipped with, by file name, for the files the player has not written yet.
   *
   * Gunner 4 reads its key bindings out of an INI file the download provides ready-filled; with
   * nothing there every binding reads as unset and no key the player presses reaches the game.
   * A default is only ever read, never written back: the moment the game saves that file, what
   * it saved is what is read from then on.
   */
  private defaults = new Map<string, IniFile>();

  useDefaults(defaults: Map<string, IniFile>): void {
    this.defaults = defaults;
  }

  setFile(object: number, path: string): void {
    this.cursor(object).file = normalisePath(path);
  }

  setGroup(object: number, group: string): void {
    this.cursor(object).group = group;
  }

  setItem(object: number, item: string): void {
    this.cursor(object).item = item;
  }

  write(object: number, value: string | number): void {
    const at = this.cursor(object);
    // With no group or item chosen there is nowhere to write, and the extension does nothing.
    if (!at.group || !at.item) return;
    const contents = this.load(at.file);
    (contents[at.group] ??= {})[at.item] = String(value);
    this.save(at.file, contents);
  }

  /**
   * Writes to a named item, leaving the standing one alone.
   *
   * The extension has both forms: one writes wherever the cursor points, and this one names the
   * item outright. Moving the cursor to do it would leave it somewhere the next write did not
   * expect, so the group is the only part taken from where the object is pointed.
   */
  writeItem(object: number, item: string, value: string | number): void {
    const at = this.cursor(object);
    if (!at.group || !item) return;
    const contents = this.load(at.file);
    (contents[at.group] ??= {})[item] = String(value);
    this.save(at.file, contents);
  }

  /** Reads a named item, leaving the object's own cursor where it is pointed. */
  readItem(object: number, item: string): number {
    const at = this.cursor(object);
    if (!at.group || !item) return 0;
    return Number(this.load(at.file)[at.group]?.[item] ?? '') || 0;
  }

  read(object: number): number {
    return Number(this.readString(object)) || 0;
  }

  readString(object: number): string {
    const at = this.cursor(object);
    if (!at.group || !at.item) return '';
    return this.load(at.file)[at.group]?.[at.item] ?? '';
  }

  private cursor(object: number): Cursor {
    let at = this.cursors.get(object);
    if (!at) {
      at = { file: normalisePath('default.ini'), group: '', item: '' };
      this.cursors.set(object, at);
    }
    return at;
  }

  private load(file: string): IniFile {
    const cached = this.files.get(file);
    if (cached) return cached;

    // What the game shipped with, under whatever the player has saved over it. The two are
    // merged item by item rather than one replacing the other: the game writes single items, so
    // a file it has touched holds only what it happened to write. Letting that stand for the
    // whole file drops everything else in it, and for this game that means the key bindings
    // vanish the first time anything saves a setting, leaving nothing the player presses bound.
    const shipped = this.defaults.get(file.split('/').pop() ?? file);
    const contents: IniFile = shipped ? structuredClone(shipped) : {};
    try {
      const raw = localStorage.getItem(PREFIX + file);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        // Anything that is not a group-of-items object counts as an absent file rather than
        // being allowed to throw later; a save slot is not worth a crash.
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [group, items] of Object.entries(parsed as IniFile)) {
            if (items === null || typeof items !== 'object') continue;
            contents[group] = { ...contents[group], ...items };
          }
        }
      }
    } catch (e) {
      console.warn(`ini: could not read ${file}: ${e}`);
    }

    this.files.set(file, contents);
    return contents;
  }

  private save(file: string, contents: IniFile): void {
    try {
      localStorage.setItem(PREFIX + file, JSON.stringify(contents));
    } catch (e) {
      console.warn(`ini: could not write ${file}: ${e}`);
    }
  }
}

/**
 * A stable key for an INI path. The paths in the game are Windows ones, so separators and case
 * are levelled out; the whole path is kept rather than the file name alone, so two files that
 * happen to share a name stay separate.
 */
function normalisePath(path: string): string {
  return path.replace(/\\/g, '/').trim().toLowerCase() || 'default.ini';
}
