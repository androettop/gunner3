//! The icon an executable wears.
//!
//! Windows keeps it in the PE resource tree, in two halves. A group (type 14) is the directory
//! an icon is named by: it lists every size and colour depth that was drawn, and the id of each.
//! The pictures themselves (type 3) are each a DIB with no file header, of twice the height it
//! claims: the picture, and under it a one-bit mask saying which of its pixels are there. A
//! 32-bit picture carries alpha of its own and the mask is ignored, as Windows ignores it.
//!
//! What comes out of here is the game's icon, never the installer's: the caller reads it from
//! the executable the game itself was found in.

use crate::pe;

/// Resource types, as the tree numbers them.
const GROUP: u32 = 14;
const PICTURE: u32 = 3;

pub struct Icon {
    pub width: u32,
    pub height: u32,
    /// Top down, eight bits a channel.
    pub rgba: Vec<u8>,
}

/// The biggest, deepest picture in the first group the executable lists, which is the icon
/// Windows shows for the program itself.
pub fn read(exe: &[u8]) -> Option<Icon> {
    let (root, sections) = pe::resources(exe)?;
    let groups = directory(exe, root, GROUP)?;
    let pictures = directory(exe, root, PICTURE)?;

    // Where there is more than one group, the program's own icon is the lowest numbered.
    let first = entries(exe, groups).into_iter().filter(|e| !e.named).min_by_key(|e| e.id)?;
    let group = leaf(exe, root, &sections, root + first.offset as usize)?;

    // Best first, and on down the list: the largest picture in a modern icon is a PNG rather
    // than a bitmap, and this reads bitmaps.
    for id in listed(group) {
        let entry = entries(exe, pictures).into_iter().find(|e| !e.named && e.id == id as u32)?;
        let dib = leaf(exe, root, &sections, root + entry.offset as usize)?;
        if let Some(icon) = decode(dib) {
            return Some(icon);
        }
    }
    None
}

/// The icon on a square of the given size, over a background.
///
/// Scaled by a whole number and sampled at the nearest pixel, so what was drawn pixel by pixel
/// stays that way however large the square is: no blending, no half pixels, no blur. `content`
/// is the most of the square the picture may take up, which is what leaves a maskable icon the
/// margin a phone is allowed to cut into.
pub fn fitted(icon: &Icon, size: u32, content: u32, background: [u8; 4]) -> Vec<u8> {
    let mut out = background.repeat((size * size) as usize);

    let box_ = content.min(size);
    let longest = icon.width.max(icon.height).max(1);
    // Whole-number scaling only has something to say while the picture is smaller than the
    // square. An icon larger than the square (a 256-pixel one on its way to 192) is sampled
    // down to fit instead, still at the nearest pixel.
    let (width, height) = if longest <= box_ {
        let scale = box_ / longest;
        (icon.width * scale, icon.height * scale)
    } else if icon.width >= icon.height {
        (box_, (icon.height * box_ / icon.width).max(1))
    } else {
        ((icon.width * box_ / icon.height).max(1), box_)
    };

    let (left, top) = ((size - width) / 2, (size - height) / 2);
    for y in 0..height {
        let source = (y * icon.height / height).min(icon.height - 1);
        for x in 0..width {
            let from = ((source * icon.width + (x * icon.width / width).min(icon.width - 1)) * 4) as usize;
            let to = (((top + y) * size + left + x) * 4) as usize;
            let (Some(pixel), Some(under)) = (icon.rgba.get(from..from + 4), out.get(to..to + 4))
            else { continue };

            // Over whatever is behind it: transparent for an icon a page shows as it is, the
            // background colour for a maskable one, which may not have holes in it.
            let alpha = pixel[3] as u32;
            let mix = |over: u8, under: u8| {
                ((over as u32 * alpha + under as u32 * (255 - alpha)) / 255) as u8
            };
            let blended = [
                mix(pixel[0], under[0]),
                mix(pixel[1], under[1]),
                mix(pixel[2], under[2]),
                (alpha + under[3] as u32 * (255 - alpha) / 255).min(255) as u8,
            ];
            out[to..to + 4].copy_from_slice(&blended);
        }
    }
    out
}

/// The ids a group lists, biggest and deepest first.
fn listed(group: &[u8]) -> Vec<u16> {
    let word = |at: usize| group.get(at..at + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap()));
    let count = word(4).unwrap_or(0) as usize;

    let mut pictures: Vec<(u32, u32, u16)> = (0..count)
        .filter_map(|index| {
            let at = 6 + index * 14;
            let entry = group.get(at..at + 14)?;
            // A side of zero means 256: the field is one byte and the size outgrew it.
            let side = |v: u8| if v == 0 { 256 } else { v as u32 };
            Some((side(entry[0]) * side(entry[1]), word(at + 6)? as u32, word(at + 12)?))
        })
        .collect();
    pictures.sort_by_key(|&(area, depth, _)| std::cmp::Reverse((area, depth)));
    pictures.into_iter().map(|(_, _, id)| id).collect()
}

/// A DIB, as a picture over its mask.
fn decode(dib: &[u8]) -> Option<Icon> {
    let word = |at: usize| dib.get(at..at + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap()));
    let long = |at: usize| dib.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));

    // Anything else here is a PNG, or a header from before Windows 3, and neither is this.
    let header = long(0)? as usize;
    if header < 40 || long(16)? != 0 {
        return None;
    }
    let width = long(4)?;
    let height = long(8)? / 2; // The mask under it is counted into the height.
    let depth = word(14)? as u32;
    if width == 0 || height == 0 || width > 1024 || height > 1024 {
        return None;
    }

    // A palette follows the header at up to eight bits, as many colours as are said to be used
    // or as the depth allows, four bytes each: blue, green, red, and one byte spare.
    let colours = match (depth, long(32)? as usize) {
        (1..=8, 0) => 1 << depth,
        (1..=8, used) => used,
        _ => 0,
    };
    let palette = dib.get(header..header + colours * 4)?;
    let at = header + colours * 4;

    // Rows are padded out to four bytes, in the picture and in the mask alike.
    let stride = ((width * depth + 31) / 32 * 4) as usize;
    let mask_stride = ((width + 31) / 32 * 4) as usize;
    let picture = dib.get(at..at + stride * height as usize)?;
    let mask = dib.get(at + stride * height as usize..).unwrap_or(&[]);
    let carries_alpha = depth == 32 && picture.chunks_exact(4).any(|p| p[3] != 0);

    // A colour out of the palette, which is written the way the pixels are: blue, green, red.
    let colour_of = |index: usize| palette.get(index * 4..index * 4 + 4);

    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        // A DIB is stored bottom up.
        let row = &picture[(height - 1 - y) as usize * stride..];
        for x in 0..width as usize {
            let colour = match depth {
                1 => colour_of(((row[x / 8] >> (7 - x % 8)) & 1) as usize),
                4 => colour_of(if x % 2 == 0 { (row[x / 2] >> 4) as usize } else { (row[x / 2] & 15) as usize }),
                8 => colour_of(row[x] as usize),
                24 => Some(&row[x * 3..x * 3 + 3]),
                32 => Some(&row[x * 4..x * 4 + 4]),
                _ => return None,
            }?;
            let alpha = if carries_alpha {
                colour[3]
            } else {
                // The mask says which pixels are there, with a set bit for one that is not.
                let bit = mask
                    .get((height - 1 - y) as usize * mask_stride + x / 8)
                    .map_or(0, |b| (b >> (7 - x % 8)) & 1);
                if bit == 1 { 0 } else { 255 }
            };
            rgba.extend_from_slice(&[colour[2], colour[1], colour[0], alpha]);
        }
    }

    Some(Icon { width, height, rgba })
}

/// One entry of a resource directory: what it is called, and what is under it.
struct Entry {
    /// A resource is named by a number or by a string; nothing here is looked up by name.
    id: u32,
    named: bool,
    /// From the start of the tree, to another directory or to a leaf.
    offset: u32,
    directory: bool,
}

/// The directory holding every resource of one type.
fn directory(data: &[u8], root: usize, kind: u32) -> Option<usize> {
    entries(data, root)
        .into_iter()
        .find(|e| !e.named && e.directory && e.id == kind)
        .map(|e| root + e.offset as usize)
}

fn entries(data: &[u8], at: usize) -> Vec<Entry> {
    let word = |o: usize| data.get(at + o..at + o + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap()));
    let (Some(named), Some(ids)) = (word(12), word(14)) else { return Vec::new() };

    (0..named as usize + ids as usize)
        .filter_map(|index| {
            let entry = at + 16 + index * 8;
            let long = |o: usize| {
                data.get(entry + o..entry + o + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            };
            let (name, value) = (long(0)?, long(4)?);
            Some(Entry {
                id: name & 0x7fff_ffff,
                named: name & 0x8000_0000 != 0,
                offset: value & 0x7fff_ffff,
                directory: value & 0x8000_0000 != 0,
            })
        })
        .collect()
}

/// The bytes under a directory, following the first of whatever is in it (the languages a
/// resource was translated into, where it was translated at all) down to the one leaf that ends
/// every branch.
fn leaf<'a>(data: &'a [u8], root: usize, sections: &pe::Sections, at: usize) -> Option<&'a [u8]> {
    let entry = entries(data, at).into_iter().next()?;
    if entry.directory {
        return leaf(data, root, sections, root + entry.offset as usize);
    }

    let leaf = root + entry.offset as usize;
    let long = |o: usize| data.get(leaf + o..leaf + o + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap()));
    let start = sections.offset(long(0)?)?;
    data.get(start..start + long(4)? as usize)
}
