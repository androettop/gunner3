//! Object definitions.
//!
//! The chunk opens with a count and then describes each object with a little chunk list of its
//! own (a header, a name, and its properties), closed by the same terminator the outer lists
//! use. Not every object has all three: some carry no name.

use crate::chunk;

pub const FRAME_ITEMS: u16 = 8745;
const HEADER: u16 = 17476;
const NAME: u16 = 17477;
const PROPERTIES: u16 = 17478;

/// Bit 2 of the header's flag word. It is the one flag the runtime needs from here: an object
/// marked global is one object across the whole application rather than one per frame, which is
/// what carries a save file's counters from the load screen into the level.
const GLOBAL_OBJECT: u16 = 1 << 2;

pub struct Object {
    pub handle: u16,
    pub object_type: u16,
    pub flags: u16,
    pub ink_effect: u32,
    pub ink_effect_param: u32,
    pub name: String,
    /// The properties, still packed; what they mean depends on the object's type.
    pub properties: Vec<u8>,
}

impl Object {
    pub fn is_global(&self) -> bool {
        self.flags & GLOBAL_OBJECT != 0
    }

    pub fn type_name(&self) -> &'static str {
        match self.object_type {
            0 => "QuickBackdrop",
            1 => "Backdrop",
            2 => "Active",
            3 => "Text",
            4 => "Question",
            5 => "Score",
            6 => "Lives",
            7 => "Counter",
            8 => "RTF",
            9 => "SubApplication",
            _ => "Extension",
        }
    }
}

pub fn read(data: &[u8]) -> Result<Vec<Object>, String> {
    if data.len() < 4 {
        return Err("object list is too short to hold its count".into());
    }
    let count = u32::from_le_bytes(data[..4].try_into().unwrap()) as usize;

    let mut objects = Vec::with_capacity(count);
    let mut at = 4;
    for index in 0..count {
        let (parts, end) = chunk::read_all(data, at)?;
        if parts.is_empty() {
            return Err(format!("object list ran out after {index} of {count}"));
        }
        at = end;

        let part = |id: u16| parts.iter().find(|p| p.id == id).map(|p| p.data.as_slice());
        let header = part(HEADER).ok_or_else(|| format!("object {index} has no header"))?;
        if header.len() < 16 {
            return Err(format!("object {index} has a short header"));
        }
        let word = |o: usize| u16::from_le_bytes(header[o..o + 2].try_into().unwrap());
        let long = |o: usize| u32::from_le_bytes(header[o..o + 4].try_into().unwrap());

        objects.push(Object {
            handle: word(0),
            object_type: word(2),
            flags: word(4),
            ink_effect: long(8),
            ink_effect_param: long(12),
            name: part(NAME)
                .map(|raw| {
                    let text = raw.split(|&b| b == 0).next().unwrap_or(raw);
                    String::from_utf8_lossy(text).into_owned()
                })
                .unwrap_or_default(),
            properties: part(PROPERTIES).map(<[u8]>::to_vec).unwrap_or_default(),
        });
    }

    Ok(objects)
}

/// One drawn direction of an animation.
pub struct Direction {
    pub index: usize,
    pub min_speed: u8,
    pub max_speed: u8,
    pub repeat: u16,
    pub repeat_frame: u16,
    pub frames: Vec<u16>,
}

pub struct Animation {
    pub id: usize,
    pub directions: Vec<Direction>,
}

/// What an object's properties say, as far as this reads them.
pub struct Common {
    pub flags: u16,
    pub new_flags: u16,
    pub identifier: String,
    pub back_color: String,
    pub animations: Vec<Animation>,
}

/// Offsets within the properties, and the fields that sit at fixed positions.
const ANIMATIONS_OFFSET: usize = 6;
const FLAGS: usize = 18;
const NEW_FLAGS: usize = 40;
const IDENTIFIER: usize = 44;
const BACK_COLOR: usize = 48;

pub fn read_common(data: &[u8]) -> Option<Common> {
    if data.len() < BACK_COLOR + 4 {
        return None;
    }
    let word = |at: usize| u16::from_le_bytes(data[at..at + 2].try_into().unwrap());

    let animations = word(ANIMATIONS_OFFSET) as usize;
    Some(Common {
        flags: word(FLAGS),
        new_flags: word(NEW_FLAGS),
        identifier: String::from_utf8_lossy(&data[IDENTIFIER..IDENTIFIER + 4]).into_owned(),
        back_color: format!("#{:02X}{:02X}{:02X}", data[BACK_COLOR], data[BACK_COLOR + 1], data[BACK_COLOR + 2]),
        animations: read_animations(data, animations).unwrap_or_default(),
    })
}

/// The animation table: a size, a count, and one offset per animation slot. A slot the object
/// does not use has an offset of zero, so the slot number is the animation's own number rather
/// than its position in a list.
fn read_animations(data: &[u8], base: usize) -> Option<Vec<Animation>> {
    if base == 0 || base + 4 > data.len() {
        return None;
    }
    let word = |at: usize| {
        data.get(at..at + 2)
            .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
    };

    let count = word(base + 2)? as usize;
    let mut animations = Vec::new();
    for slot in 0..count {
        let offset = word(base + 4 + slot * 2)? as usize;
        if offset == 0 {
            continue;
        }
        let at = base + offset;
        let mut directions = Vec::new();
        // Thirty-two directions, again by slot rather than by position.
        for index in 0..32 {
            let where_ = word(at + index * 2)? as usize;
            if where_ == 0 {
                continue;
            }
            directions.push(read_direction(data, at + where_, index)?);
        }
        animations.push(Animation { id: slot, directions });
    }
    Some(animations)
}

fn read_direction(data: &[u8], at: usize, index: usize) -> Option<Direction> {
    let word = |o: usize| {
        data.get(at + o..at + o + 2)
            .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
    };
    let count = word(6)? as usize;
    let mut frames = Vec::with_capacity(count);
    for frame in 0..count {
        frames.push(word(8 + frame * 2)?);
    }
    Some(Direction {
        index,
        min_speed: *data.get(at)?,
        max_speed: *data.get(at + 1)?,
        repeat: word(2)?,
        repeat_frame: word(4)?,
        frames,
    })
}

pub struct Paragraph {
    pub text: String,
    pub color: String,
    pub font: u16,
}

pub struct Movement {
    pub kind: u16,
    /// Which player drives it, for the kinds that take a controller; zero for the rest.
    pub player: u16,
    pub starting_direction: u32,
    /// The settings the movement's own kind gives it, named as the runtime asks for them.
    pub values: Vec<(&'static str, i64)>,
    /// A path movement's nodes, in order; empty for every other kind.
    pub nodes: Vec<PathNode>,
}

/// One leg of a path: how far it goes, how fast, and how long to wait at the end of it.
#[derive(Clone, Copy)]
pub struct PathNode {
    pub speed: u8,
    pub direction: u8,
    pub dx: i16,
    pub dy: i16,
    pub cos: i16,
    pub sin: i16,
    pub length: u16,
    pub pause: u16,
}

pub struct Counter {
    pub initial: i32,
    pub minimum: i32,
    pub maximum: i32,
    pub display: u32,
    pub width: u16,
    pub height: u16,
    pub frames: Vec<u16>,
}

/// A backdrop's properties, and a quick backdrop's, which add a shape to them.
pub struct Backdrop {
    pub obstacle_type: u16,
    pub collision_type: u16,
    pub width: u16,
    pub height: u16,
    pub image: u16,
    pub shape: Option<Shape>,
}

pub struct Shape {
    pub border_size: u16,
    pub border_color: String,
    pub shape_type: u16,
    pub fill_type: u16,
    pub color1: String,
    pub color2: String,
    pub vertical_gradient: bool,
}

const MOVEMENTS_OFFSET: usize = 4;
const COUNTER_OFFSET: usize = 10;
const SYSTEM_OFFSET: usize = 12;

fn colour(data: &[u8], at: usize) -> String {
    format!("#{:02X}{:02X}{:02X}", data[at], data[at + 1], data[at + 2])
}

fn word(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..at + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap()))
}

fn long(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()))
}

/// Backdrops give an image; quick backdrops give a size and a shape to fill it with.
pub fn read_backdrop(data: &[u8], quick: bool) -> Option<Backdrop> {
    let obstacle_type = word(data, 4)?;
    let collision_type = word(data, 6)?;
    if !quick {
        return Some(Backdrop {
            obstacle_type, collision_type,
            width: 0, height: 0,
            image: word(data, 8)?,
            shape: None,
        });
    }

    // The shape is not a fixed record: the colours are only there for the fills that use them,
    // so the image handle that follows sits at a different place depending on the fill. Reading
    // it at one offset gives the tiled backdrops an image of zero, and a level whose ground is
    // missing is a level the player falls out of.
    let fill_type = word(data, 20)?;
    let (color1, color2, vertical_gradient, image_at) = match fill_type {
        1 => (colour(data, 22), String::from("#FFFFFF"), false, 26),
        2 => (colour(data, 22), colour(data, 26), word(data, 30)? != 0, 32),
        _ => (String::from("#FFFFFF"), String::from("#FFFFFF"), false, 22),
    };

    Some(Backdrop {
        obstacle_type,
        collision_type,
        width: word(data, 8)?,
        height: word(data, 10)?,
        image: word(data, image_at)?,
        shape: Some(Shape {
            border_size: word(data, 12)?,
            border_color: colour(data, 14),
            shape_type: word(data, 18)?,
            fill_type,
            color1,
            color2,
            vertical_gradient,
        }),
    })
}

/// The counter's reading, the range it is held to, and how it draws itself.
///
/// The reading and the range are all a counter that only feeds expressions needs, and that is
/// where the block stops for most of them. One that draws itself carries how, and the images it
/// draws with: display 0 is hidden, 1 a row of digit images, 2 and 3 bars, 4 an animation and
/// 5 text, and the frames are one image per glyph in the order 0-9 then the sign and the point.
/// A save slot's "LEVEL: 0" is a counter of the first kind, so dropping this leaves the
/// load screen showing its labels and no numbers.
pub fn read_counter(data: &[u8]) -> Option<Counter> {
    let base = word(data, COUNTER_OFFSET)? as usize;
    if base == 0 {
        return None;
    }
    let count = word(data, base + FRAME_COUNT).unwrap_or(0) as usize;
    Some(Counter {
        initial: long(data, base + 2)? as i32,
        minimum: long(data, base + 6)? as i32,
        maximum: long(data, base + 10)? as i32,
        display: long(data, base + DISPLAY).unwrap_or(0),
        width: word(data, base + WIDTH).unwrap_or(0),
        height: word(data, base + HEIGHT).unwrap_or(0),
        frames: (0..count)
            .filter_map(|i| word(data, base + FRAME_COUNT + 2 + i * 2))
            .collect(),
    })
}

/// Where the drawing settings sit inside the counter block, past the reading and the range.
const WIDTH: usize = 18;
const HEIGHT: usize = 20;
const DISPLAY: usize = 24;
const FRAME_COUNT: usize = 28;

/// One movement per object here, so the section's own kind is the movement's.
///
/// Twelve bytes of header, then the settings the kind calls for: a ball's speed and bounce, a
/// platform's gravity, a path's nodes. Those settings are the movement, and without them an
/// object that carries one stands still: the remote missile steers but never travels, and the
/// sparks a shot throws off sit where they were made instead of flying apart.
pub fn read_movements(data: &[u8]) -> Vec<Movement> {
    let Some(base) = word(data, MOVEMENTS_OFFSET).map(|v| v as usize) else { return Vec::new() };
    if base == 0 {
        return Vec::new();
    }
    let Some(kind) = word(data, base + 2) else { return Vec::new() };
    let player = word(data, base).unwrap_or(0);
    let starting_direction = long(data, base + 8).unwrap_or(0);
    // "Moving at start" decides whether an object begins at its configured speed, so it is a
    // setting and not a count: every object that carries a movement here carries exactly one.
    let header = vec![
        ("Control", word(data, base).unwrap_or(0) as i64),
        ("Move", word(data, base + MOVE).unwrap_or(0) as i64),
        ("Opt", word(data, base + 6).unwrap_or(0) as i64),
    ];
    let at = base + SETTINGS;
    let value = |o: usize| word(data, at + o).unwrap_or(0) as i64;

    // Only the kinds this game uses are read. Reading the others would be writing down a guess:
    // there is nothing here to check it against.
    let mut values = header;
    values.extend(match kind {
        BALL => vec![
            ("Speed", value(0)), ("Bounce", value(2)), ("Angles", value(4)),
            ("Security", value(6)), ("Decelerate", value(8)),
        ],
        PATH => vec![
            ("NodeCount", value(0)), ("MinimumSpeed", value(2)), ("MaximumSpeed", value(4)),
            ("Loop", data.get(at + 6).copied().unwrap_or(0) as i64),
            ("Reposition", data.get(at + 7).copied().unwrap_or(0) as i64),
            ("Reverse", data.get(at + 8).copied().unwrap_or(0) as i64),
        ],
        PLATFORM => vec![
            ("Speed", value(0)), ("Acceleration", value(2)), ("Deceleration", value(4)),
            ("JumpControl", value(6)), ("Gravity", value(8)), ("Jump", value(10)),
        ],
        _ => Vec::new(),
    });

    let nodes = if kind == PATH { read_path_nodes(data, at + NODES, value(0) as usize) } else { Vec::new() };

    vec![Movement { kind, player, starting_direction, values, nodes }]
}

/// The nodes of a path, fourteen bytes each, one after the other.
fn read_path_nodes(data: &[u8], mut at: usize, count: usize) -> Vec<PathNode> {
    let mut nodes = Vec::with_capacity(count);
    for _ in 0..count {
        let Some(&speed) = data.get(at) else { break };
        let Some(&direction) = data.get(at + 1) else { break };
        let short = |o: usize| word(data, at + o).unwrap_or(0);
        nodes.push(PathNode {
            speed,
            direction,
            dx: short(2) as i16,
            dy: short(4) as i16,
            cos: short(6) as i16,
            sin: short(8) as i16,
            length: short(10),
            pause: short(12),
        });
        at += NODE_SIZE;
    }
    nodes
}

/// A movement's kind, where the kind's own settings start, and how long a path node is.
const BALL: u16 = 4;
const PATH: u16 = 5;
const PLATFORM: u16 = 9;
const MOVE: usize = 4;
const SETTINGS: usize = 12;
const NODES: usize = 10;
const NODE_SIZE: usize = 14;

/// The strings a text object shows and a question object offers, each with its own colour and
/// font: a count, an offset per paragraph, and then the paragraphs themselves.
///
/// Only text and question objects keep them. The offset they sit behind is used for something
/// else by everything else, so reading it unconditionally invents paragraphs for counters.
pub fn read_paragraphs(data: &[u8], object_type: u16) -> Vec<Paragraph> {
    if !matches!(object_type, 3 | 4) {
        return Vec::new();
    }
    let Some(base) = word(data, SYSTEM_OFFSET).map(|v| v as usize) else { return Vec::new() };
    if base == 0 {
        return Vec::new();
    }
    // Eight bytes sit ahead of the table, and an offset in it is measured from `base` rather
    // than from the table itself.
    let Some(count) = word(data, base + 8) else { return Vec::new() };

    let mut paragraphs = Vec::new();
    for index in 0..count as usize {
        let Some(offset) = word(data, base + 10 + index * 2) else { break };
        let at = base + offset as usize;
        let (Some(font), Some(_)) = (word(data, at + 2), long(data, at + 4)) else { break };
        let text_at = at + 10;
        let Some(rest) = data.get(text_at..) else { break };
        let text = rest.split(|&b| b == 0).next().unwrap_or(rest);
        paragraphs.push(Paragraph {
            text: String::from_utf8_lossy(text).into_owned(),
            color: colour(data, at + 4),
            font,
        });
    }
    paragraphs
}
