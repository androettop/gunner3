//! Finding a Clickteam game inside its executable.
//!
//! The game is appended to a normal Windows executable, past everything the loader maps, so it
//! starts where the last section's raw data ends.

/// Byte offset of whatever was appended after the last PE section, or None if this is not a PE.
pub fn appended_offset(data: &[u8]) -> Option<usize> {
    if data.get(..2)? != b"MZ" {
        return None;
    }
    let pe = u32::from_le_bytes(data.get(0x3c..0x40)?.try_into().ok()?) as usize;
    if data.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }

    let sections = u16::from_le_bytes(data.get(pe + 6..pe + 8)?.try_into().ok()?) as usize;
    let optional_size = u16::from_le_bytes(data.get(pe + 20..pe + 22)?.try_into().ok()?) as usize;
    let table = pe + 24 + optional_size;

    let mut end = 0usize;
    for index in 0..sections {
        let entry = table + index * 40;
        let raw_size = u32::from_le_bytes(data.get(entry + 16..entry + 20)?.try_into().ok()?) as usize;
        let raw_offset = u32::from_le_bytes(data.get(entry + 20..entry + 24)?.try_into().ok()?) as usize;
        end = end.max(raw_offset + raw_size);
    }

    (end > 0 && end < data.len()).then_some(end)
}
