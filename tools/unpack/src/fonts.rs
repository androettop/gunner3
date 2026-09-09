//! The fonts a game's text objects are written in.
//!
//! Each entry ends in the `LOGFONT` the editor was handed when the author picked a font, in the
//! 16-bit shape Windows 3 used: five `INT16`s, eight flag bytes, and a face name. What comes
//! before it is the bank's own bookkeeping.
//!
//! The sizes are what Windows calls logical units, which at the resolution these games were
//! drawn for are pixels. A height is negative when it is the height of a character rather than
//! of the cell around it, which is the one a browser is asked for.

use crate::bank;

pub struct Font {
    pub handle: u32,
    /// The face as Windows named it, which is what a browser is asked for first.
    pub face: String,
    /// Character height in pixels, however the `LOGFONT` happened to say it.
    pub size: i32,
    /// 400 for regular and 700 for bold, as Windows and CSS both count it.
    pub weight: i32,
    pub italic: bool,
    pub underline: bool,
}

/// Where the `LOGFONT` starts, and where its fields sit inside it.
const LOGFONT: usize = 14;
const HEIGHT: usize = 0;
const WEIGHT: usize = 8;
const ITALIC: usize = 10;
const UNDERLINE: usize = 11;
const FACE: usize = 18;
const FACE_LENGTH: usize = 32;

pub fn read(data: &[u8]) -> Result<Vec<Font>, String> {
    bank::read(data, "font")?
        .into_iter()
        .map(|entry| {
            let Some(font) = entry.data.get(LOGFONT..) else {
                return Err(format!("font {} is shorter than a LOGFONT", entry.handle));
            };
            if font.len() < FACE + FACE_LENGTH {
                return Err(format!("font {} is shorter than a LOGFONT", entry.handle));
            }
            let short = |at: usize| i16::from_le_bytes(font[at..at + 2].try_into().unwrap());
            let raw = &font[FACE..FACE + FACE_LENGTH];
            let face = raw.split(|&b| b == 0).next().unwrap_or(raw);
            Ok(Font {
                handle: entry.handle,
                face: String::from_utf8_lossy(face).into_owned(),
                size: short(HEIGHT).unsigned_abs() as i32,
                weight: short(WEIGHT) as i32,
                italic: font[ITALIC] != 0,
                underline: font[UNDERLINE] != 0,
            })
        })
        .collect()
}
