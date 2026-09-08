//! Frames: the levels and menu screens.
//!
//! A frame is a chunk list of its own, with the same headers and the same compression as the
//! outer one: a header, a name, a palette, the objects placed in it, and its events.

use crate::chunk;

pub const FRAME: u16 = 13107;
const HEADER: u16 = 13108;
const NAME: u16 = 13109;
const PALETTE: u16 = 13111;
const INSTANCES: u16 = 13112;
const EVENTS: u16 = 13117;

pub struct Instance {
    pub handle: u16,
    pub object_info: u16,
    pub x: i16,
    pub y: i16,
    pub parent_type: u16,
    pub parent_handle: u16,
}

pub struct Frame {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub background: String,
    pub instances: Vec<Instance>,
    /// The event table, still packed; reading it is its own job.
    pub events: Vec<u8>,
}

pub fn read(index: usize, data: &[u8]) -> Result<Frame, String> {
    let (parts, _) = chunk::read_all(data, 0)?;
    let part = |id: u16| parts.iter().find(|p| p.id == id).map(|p| p.data.as_slice());

    let header = part(HEADER).ok_or("frame has no header")?;
    if header.len() < 10 {
        return Err("frame header is too short".into());
    }
    let width = u16::from_le_bytes(header[0..2].try_into().unwrap()) as u32;
    let height = u16::from_le_bytes(header[2..4].try_into().unwrap()) as u32;
    // Stored red first, with a fourth byte that is not part of the colour.
    let background = format!("#{:02X}{:02X}{:02X}", header[4], header[5], header[6]);

    let name = part(NAME)
        .map(|raw| {
            let text = raw.split(|&b| b == 0).next().unwrap_or(raw);
            String::from_utf8_lossy(text).into_owned()
        })
        .unwrap_or_default();

    let _ = PALETTE;
    let instances = part(INSTANCES).map(read_instances).transpose()?.unwrap_or_default();
    let events = part(EVENTS).map(<[u8]>::to_vec).unwrap_or_default();

    Ok(Frame { index, name, width, height, background, instances, events })
}

/// A count, then twelve bytes an instance.
fn read_instances(data: &[u8]) -> Result<Vec<Instance>, String> {
    if data.len() < 4 {
        return Err("instance list is too short to hold its count".into());
    }
    let count = u32::from_le_bytes(data[..4].try_into().unwrap()) as usize;

    let mut instances = Vec::with_capacity(count);
    for index in 0..count {
        let at = 4 + index * 12;
        let field = data.get(at..at + 12).ok_or("instance list ended early")?;
        let word = |o: usize| u16::from_le_bytes(field[o..o + 2].try_into().unwrap());
        instances.push(Instance {
            handle: word(0),
            object_info: word(2),
            x: word(4) as i16,
            y: word(6) as i16,
            parent_type: word(8),
            parent_handle: word(10),
        });
    }
    Ok(instances)
}
