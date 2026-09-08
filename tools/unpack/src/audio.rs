//! Sounds and music, as they come out of their banks.
//!
//! Both are laid out the same way: a header, the item's name, and then the item. Music is a MIDI
//! file stored whole. A sound is not: it is the wave format structure and then the samples, with
//! nothing wrapping them, so the RIFF file has to be built around them here.

use crate::bank;

pub struct Sound {
    pub handle: u32,
    pub name: String,
    /// A complete RIFF file, built from the format and the samples.
    pub wav: Vec<u8>,
}

pub struct Music {
    pub handle: u32,
    pub name: String,
    pub midi: Vec<u8>,
}

/// The fixed part of an item's header, before its name.
const HEADER: usize = 22;

fn split(data: &[u8], what: &str) -> Result<(String, usize), String> {
    if data.len() < HEADER {
        return Err(format!("{what} is shorter than its header"));
    }
    let name_length = u32::from_le_bytes(data[18..22].try_into().unwrap()) as usize;
    let end = HEADER + name_length;
    if end > data.len() {
        return Err(format!("{what} name runs past the end"));
    }
    let raw = &data[HEADER..end];
    let name = raw.split(|&b| b == 0).next().unwrap_or(raw);
    Ok((String::from_utf8_lossy(name).into_owned(), end))
}

pub fn read_sounds(data: &[u8]) -> Result<Vec<Sound>, String> {
    bank::read(data, "sound")?
        .into_iter()
        .map(|entry| {
            let (name, at) = split(&entry.data, "sound")?;
            let body = &entry.data[at..];
            if body.len() < 20 {
                return Err(format!("sound {} has no format block", entry.handle));
            }
            // Sixteen bytes of wave format, then the length of the samples, then the samples.
            let format: [u8; 16] = body[..16].try_into().unwrap();
            let samples = &body[20..];
            Ok(Sound { handle: entry.handle, name, wav: riff(&format, samples) })
        })
        .collect()
}

pub fn read_music(data: &[u8]) -> Result<Vec<Music>, String> {
    bank::read(data, "music")?
        .into_iter()
        .map(|entry| {
            let (name, at) = split(&entry.data, "music")?;
            Ok(Music { handle: entry.handle, name, midi: entry.data[at..].to_vec() })
        })
        .collect()
}

/// Wraps samples in the RIFF file a player expects.
fn riff(format: &[u8; 16], samples: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() + 44);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(format);
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    out.extend_from_slice(samples);
    out
}
