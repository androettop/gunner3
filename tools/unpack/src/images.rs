//! Images, as they come out of the image bank.

use crate::bank;

/// Flags on an image, by bit: 0 RLE, 1 RLEW, 2 RLET, 3 LZX, 4 Alpha, 5 ACE, 6 Mac.
const RLE_ANY: u8 = 0b0000_0111;

pub struct Image {
    pub handle: u32,
    pub width: u32,
    pub height: u32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub action_x: i32,
    pub action_y: i32,
    pub graphic_mode: u8,
    /// Eight bits per channel, red first, one pixel after another.
    pub rgba: Vec<u8>,
}

pub fn read_bank(data: &[u8]) -> Result<Vec<Image>, String> {
    bank::read(data, "image")?
        .into_iter()
        .map(|entry| decode(entry.handle, &entry.data).map_err(|e| format!("image {}: {e}", entry.handle)))
        .collect()
}

/// The 24 bytes an image opens with, and then its pixels.
fn decode(handle: u32, data: &[u8]) -> Result<Image, String> {
    if data.len() < 24 {
        return Err("shorter than its header".into());
    }
    let word = |at: usize| u16::from_le_bytes(data[at..at + 2].try_into().unwrap());

    let width = word(10) as u32;
    let height = word(12) as u32;
    let graphic_mode = data[14];
    let flags = data[15];

    let point = point_size(graphic_mode)
        .ok_or_else(|| format!("graphic mode {graphic_mode} is not one this reads"))?;
    let body = &data[24..];

    let points = if flags & RLE_ANY != 0 {
        unpack_rle(body, width as usize, height as usize, point)?
    } else {
        unpack_plain(body, width as usize, height as usize, point)?
    };

    Ok(Image {
        handle,
        width,
        height,
        hotspot_x: word(16) as i16 as i32,
        hotspot_y: word(18) as i16 as i32,
        action_x: word(20) as i16 as i32,
        action_y: word(22) as i16 as i32,
        graphic_mode,
        rgba: to_rgba(&points),
    })
}

fn point_size(graphic_mode: u8) -> Option<usize> {
    match graphic_mode {
        4 => Some(3),      // sixteen million colours
        6 | 7 => Some(2),  // thirty-two thousand, sixty-five thousand
        _ => None,
    }
}

/// Rows are padded out to an even number of bytes, in whole pixels.
fn row_padding(width: usize, point: usize) -> usize {
    let over = (width * point) % 2;
    if over == 0 {
        0
    } else {
        (2 - over).div_ceil(point)
    }
}

fn read_point(data: &[u8], at: usize, point: usize) -> Result<[u8; 3], String> {
    let bytes = data.get(at..at + point).ok_or("pixels run past the end")?;
    Ok(match point {
        3 => [bytes[2], bytes[1], bytes[0]],
        _ => {
            // Five or six bits a channel, widened back out to eight.
            let value = u16::from_le_bytes([bytes[0], bytes[1]]);
            let (r, g, b) = (value >> 11 & 0x1f, value >> 5 & 0x3f, value & 0x1f);
            [(r << 3) as u8, (g << 2) as u8, (b << 3) as u8]
        }
    })
}

/// Runs of a repeated pixel and runs of literal ones, ending at a zero command. Positions that
/// fall in a row's padding are read but not kept.
fn unpack_rle(data: &[u8], width: usize, height: usize, point: usize) -> Result<Vec<[u8; 3]>, String> {
    let pad = row_padding(width, point);
    let stride = width + pad;
    let mut out = Vec::with_capacity(width * height);
    let mut at = 0;
    let mut position = 0;

    loop {
        let command = *data.get(at).ok_or("ran out before the end of the pixels")?;
        at += 1;
        if command == 0 {
            break;
        }

        if command > 128 {
            for _ in 0..command - 128 {
                if position % stride < width {
                    out.push(read_point(data, at, point)?);
                }
                position += 1;
                at += point;
            }
        } else {
            let pixel = read_point(data, at, point)?;
            for _ in 0..command {
                if position % stride < width {
                    out.push(pixel);
                }
                position += 1;
            }
            at += point;
        }
    }

    Ok(out)
}

fn unpack_plain(data: &[u8], width: usize, height: usize, point: usize) -> Result<Vec<[u8; 3]>, String> {
    let pad = row_padding(width, point);
    let mut out = Vec::with_capacity(width * height);
    let mut at = 0;
    for _ in 0..height {
        for _ in 0..width {
            out.push(read_point(data, at, point)?);
            at += point;
        }
        at += pad * point;
    }
    Ok(out)
}

/// Black is the transparent colour in this format, and there is no separate alpha channel.
fn to_rgba(points: &[[u8; 3]]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(points.len() * 4);
    for point in points {
        let opaque = point != &[0, 0, 0];
        rgba.extend_from_slice(point);
        rgba.push(if opaque { 255 } else { 0 });
    }
    rgba
}
