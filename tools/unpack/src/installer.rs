//! Clickteam Install Creator installers.
//!
//! What the game's own page hands you is not the game: it is an installer with the game inside.
//! The payload sits after the executable, as a flat list of chunks:
//!
//! ```text
//! tag    uint32    compressed when its high half is set
//! size   uint32
//! body   size bytes
//! ```
//!
//! A compressed body is a uint32 decompressed length and then the same stream the game itself
//! uses. Two tags matter: 0x1243 lists the files, and 0x7F7F holds them. The list chunk gives
//! each file's compressed and decompressed lengths, and the blob is every file's stream one
//! after another in that order.

use crate::inflate;

const FILE_TABLE: u32 = 0x1243;
const BLOB: u32 = 0x7F7F;

/// Every file the installer carries, in the order it lists them.
pub fn unpack(data: &[u8], start: usize) -> Result<Vec<Vec<u8>>, String> {
    let mut table = None;
    let mut blob = None;

    let mut at = start;
    while at + 8 <= data.len() {
        let tag = u32::from_le_bytes(data[at..at + 4].try_into().unwrap());
        let size = u32::from_le_bytes(data[at + 4..at + 8].try_into().unwrap()) as usize;

        // The blob's body carries its own length and then runs to the end of the file, four
        // bytes past what its header claims. Trusting the header leaves every stream after the
        // first decoding to rubbish.
        if tag & 0xFFFF == BLOB {
            blob = Some(&data[at + 12..]);
            break;
        }
        if at + 8 + size > data.len() {
            break;
        }

        let body = &data[at + 8..at + 8 + size];
        at += 8 + size;

        if tag & 0xFFFF == FILE_TABLE {
            table = Some(if tag & 0xFFFF_0000 != 0 { decompress(body)? } else { body.to_vec() });
        }
    }

    let (Some(table), Some(blob)) = (table, blob) else {
        return Err("no file table and blob in this installer".into());
    };

    let mut files = Vec::new();
    let mut offset = 0;
    for (expected, compressed) in entries(&table) {
        let Some(stream) = blob.get(offset..offset + compressed) else { break };
        offset += compressed;
        match inflate::inflate(stream, expected) {
            Ok((file, _)) => files.push(file),
            // A file this cannot read is not worth failing the whole installer over: the one
            // being looked for may well be the next.
            Err(e) => eprintln!("  a file in the installer did not decompress: {e}"),
        }
    }

    Ok(files)
}

/// The lengths of each listed file: a count, then entries that each say how long they are.
///
/// An entry opens with its own length (counted from that field, so the next entry is that far
/// on), and carries the two lengths at a fixed distance into it, the decompressed one first.
/// The file's name follows them, and then, for the ones the installer makes shortcuts for, the
/// shortcut's title and description; the names are what makes an entry's length vary.
fn entries(table: &[u8]) -> Vec<(usize, usize)> {
    if table.len() < 4 {
        return Vec::new();
    }
    let count = u32::from_le_bytes(table[..4].try_into().unwrap()) as usize;

    let mut sizes = Vec::with_capacity(count);
    let mut at = 4;
    for _ in 0..count {
        let Some(size) = table.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize)
        else { break };
        if size < ENTRY_NAME || at + size > table.len() {
            break;
        }
        let long = |o: usize| u32::from_le_bytes(table[at + o..at + o + 4].try_into().unwrap()) as usize;
        sizes.push((long(ENTRY_DECOMPRESSED), long(ENTRY_COMPRESSED)));
        at += size;
    }
    sizes
}

/// Where the two lengths and the name sit inside an entry, measured from its length field.
const ENTRY_DECOMPRESSED: usize = 18;
const ENTRY_COMPRESSED: usize = 22;
const ENTRY_NAME: usize = 26;

fn decompress(body: &[u8]) -> Result<Vec<u8>, String> {
    if body.len() < 4 {
        return Err("compressed chunk is too short".into());
    }
    let expected = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
    inflate::inflate(&body[4..], expected).map(|(data, _)| data)
}
