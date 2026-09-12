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

/// The section table, which is what turns an address the loader would use into a file offset.
pub struct Sections(Vec<Section>);

struct Section {
    rva: u32,
    size: u32,
    offset: u32,
}

impl Sections {
    /// Where a virtual address sits in the file, or None if no section holds it.
    pub fn offset(&self, rva: u32) -> Option<usize> {
        self.0
            .iter()
            .find(|s| rva >= s.rva && rva - s.rva < s.size)
            .map(|s| (s.offset + (rva - s.rva)) as usize)
    }
}

/// The resource tree: where it begins in the file, and the sections to follow it with.
///
/// Everything inside the tree is addressed the way the loader would address it once the file is
/// mapped into memory, so reading it off a disk means putting every one of those addresses back
/// through the section table.
pub fn resources(data: &[u8]) -> Option<(usize, Sections)> {
    if data.get(..2)? != b"MZ" {
        return None;
    }
    let pe = u32::from_le_bytes(data.get(0x3c..0x40)?.try_into().ok()?) as usize;
    if data.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    let word = |at: usize| data.get(at..at + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap()));
    let long = |at: usize| data.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));

    let count = word(pe + 6)? as usize;
    let optional_size = word(pe + 20)? as usize;
    let optional = pe + 24;

    // The data directories sit at the end of the optional header, and a 64-bit one is sixteen
    // bytes longer on the way there. Each is an address and a length, and the third of them is
    // the resources.
    let directories = match word(optional)? {
        0x10b => optional + 96,
        0x20b => optional + 112,
        _ => return None,
    };
    let root = long(directories + 16)?;
    if root == 0 {
        return None;
    }

    let table = optional + optional_size;
    let mut sections = Vec::with_capacity(count);
    for index in 0..count {
        let entry = table + index * 40;
        sections.push(Section {
            rva: long(entry + 12)?,
            size: long(entry + 16)?,
            offset: long(entry + 20)?,
        });
    }
    let sections = Sections(sections);

    let start = sections.offset(root)?;
    (start < data.len()).then_some((start, sections))
}
