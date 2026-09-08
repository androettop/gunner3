//! The chunk list a Clickteam game is stored as.
//!
//! Every chunk is a two-byte id, two bytes of flags and a four-byte length. Flags of exactly 1
//! mean the body is compressed: a four-byte decompressed length followed by a raw DEFLATE
//! stream: raw, with none of zlib's framing around it. The list ends at chunk 0x7F7F.

use crate::inflate;

pub const LAST: u16 = 0x7F7F;
const COMPRESSED: u16 = 1;

pub struct Chunk {
    pub id: u16,
    pub data: Vec<u8>,
}

/// Reads a chunk list starting at `offset`, and reports where it ended.
///
/// A game file holds two of these one after the other: the pack data, which carries the
/// extension binaries the game shipped with, and then the game itself.
pub fn read_all(data: &[u8], offset: usize) -> Result<(Vec<Chunk>, usize), String> {
    let mut chunks = Vec::new();
    let mut at = offset;

    while at + 8 <= data.len() {
        let id = u16::from_le_bytes(data[at..at + 2].try_into().unwrap());
        let flags = u16::from_le_bytes(data[at + 2..at + 4].try_into().unwrap());
        let size = u32::from_le_bytes(data[at + 4..at + 8].try_into().unwrap()) as usize;
        at += 8;

        if id == LAST {
            break;
        }
        if at + size > data.len() {
            return Err(format!("chunk {id:#06x} at {at:#x} runs past the end of the file"));
        }

        let body = &data[at..at + size];
        at += size;

        let decoded = if flags == COMPRESSED {
            inflate(body).map_err(|e| format!("chunk {id} ({id:#06x}) at {:#x}: {e}", at - size))?
        } else {
            body.to_vec()
        };
        chunks.push(Chunk { id, data: decoded });
    }

    Ok((chunks, at))
}

/// A compressed chunk body: its decompressed length, then a raw DEFLATE stream.
fn inflate(body: &[u8]) -> Result<Vec<u8>, String> {
    if body.len() < 4 {
        return Err("compressed chunk is too short to hold its length".into());
    }
    let expected = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;

    let (out, _) = inflate::inflate(&body[4..], expected)?;

    if out.len() != expected {
        return Err(format!("inflated {} bytes, expected {expected}", out.len()));
    }
    Ok(out)
}
