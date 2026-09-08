//! Banks of images, sounds and music, which are all laid out the same way.
//!
//! A count, then one entry per item: its handle, the size it comes to once decompressed, and its
//! stream. The entry does not say how long the stream is: the decoder finds out by decoding it,
//! and the next entry begins where it stopped.

use crate::inflate;

pub struct Entry {
    pub handle: u32,
    pub data: Vec<u8>,
}

pub fn read(bank: &[u8], what: &str) -> Result<Vec<Entry>, String> {
    if bank.len() < 4 {
        return Err(format!("{what} bank is too short to hold its count"));
    }
    let count = u32::from_le_bytes(bank[..4].try_into().unwrap()) as usize;

    let mut entries = Vec::with_capacity(count);
    let mut at = 4;
    for index in 0..count {
        if at + 8 > bank.len() {
            return Err(format!("{what} bank ended after {index} of {count}"));
        }
        let handle = u32::from_le_bytes(bank[at..at + 4].try_into().unwrap());
        let expected = u32::from_le_bytes(bank[at + 4..at + 8].try_into().unwrap()) as usize;
        at += 8;

        let (data, used) = inflate::inflate(&bank[at..], expected)
            .map_err(|e| format!("{what} {handle} (entry {index}): {e}"))?;
        at += used;
        entries.push(Entry { handle, data });
    }

    Ok(entries)
}
