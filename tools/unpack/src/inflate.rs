//! The compression these games use: DEFLATE's coding under a header of its own.
//!
//! The bit reader, the Huffman coding, the length and distance tables and the back-references
//! are all RFC 1951. What differs is how a block announces itself. DEFLATE spends three bits on
//! that: one saying whether the block is the last, two naming its kind. Here it spends four:
//! one for the last-block flag and three for the kind, and the kinds are numbered differently:
//! 5 for a block coded with the fixed tree, 6 for one carrying its own, 7 for a stored one. A
//! stored block gives its length once rather than following it with the complement.
//!
//! None of that is guessed. Feeding the game's own application header to a stock decoder yields
//! nothing; read this way it comes out as its 84 bytes exactly, with the window size and the
//! colour mode where they belong, and the three short chunks beside it come out as the game's
//! name, its author's, and the path the project was built from.

struct Bits<'a> {
    data: &'a [u8],
    /// Bit position from the start of the data, counting from the low bit of each byte.
    at: usize,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, at: 0 }
    }

    fn bit(&mut self) -> Result<u32, String> {
        let (byte, offset) = (self.at >> 3, self.at & 7);
        let value = *self.data.get(byte).ok_or("ran off the end of the stream")?;
        self.at += 1;
        Ok(((value >> offset) & 1) as u32)
    }

    /// `count` bits, first bit read being the least significant.
    fn bits(&mut self, count: u32) -> Result<u32, String> {
        let mut value = 0;
        for index in 0..count {
            value |= self.bit()? << index;
        }
        Ok(value)
    }

    fn align(&mut self) {
        self.at = (self.at + 7) & !7;
    }

    /// How many bytes the reader has drawn on. The byte holding the last bit read counts as
    /// used, which is what lets the next entry in a bank start where this one stopped.
    fn byte_position(&self) -> usize {
        (self.at + 7) >> 3
    }
}

/// A canonical Huffman table: symbols ordered by code length, and how many codes of each length.
struct Tree {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

impl Tree {
    /// Builds a table from one code length per symbol; zero means the symbol is not coded.
    fn new(lengths: &[u8]) -> Self {
        let mut counts = [0u16; 16];
        for &length in lengths {
            counts[length as usize] += 1;
        }
        counts[0] = 0;

        let mut offsets = [0u16; 16];
        let mut total = 0;
        for length in 0..16 {
            offsets[length] = total;
            total += counts[length];
        }

        let mut symbols = vec![0u16; total as usize];
        for (symbol, &length) in lengths.iter().enumerate() {
            if length != 0 {
                symbols[offsets[length as usize] as usize] = symbol as u16;
                offsets[length as usize] += 1;
            }
        }

        Self { counts, symbols }
    }

    /// Walks the tree a bit at a time, which is what makes an incomplete tree decodable.
    fn decode(&self, bits: &mut Bits) -> Result<u16, String> {
        let mut code = 0i32;
        let mut first = 0i32;
        let mut index = 0i32;

        for length in 1..16 {
            code |= bits.bit()? as i32;
            let count = self.counts[length] as i32;
            if code - first < count {
                return Ok(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err("no symbol matched in 15 bits".into())
    }
}

const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
/// The order the code-length alphabet's own lengths are stored in, and the last thing about
/// this format that is not DEFLATE's. DEFLATE interleaves the order so that the lengths most
/// likely to be used come first; this simply puts the three repeat codes at the front, largest
/// first, and then counts up.
const LENGTH_ORDER: [usize; 19] = [
    18, 17, 16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

/// Inflates a stream, stopping at the final block. Returns the output and the bytes consumed.
pub fn inflate(data: &[u8], expected: usize) -> Result<(Vec<u8>, usize), String> {
    let mut bits = Bits::new(data);
    let mut out = Vec::with_capacity(expected);

    loop {
        let kind = bits.bits(3)?;
        let final_block = bits.bit()? == 1;
        match kind {
            STORED => stored(&mut bits, &mut out)?,
            FIXED => block(&mut bits, &mut out, &fixed_literals(), &fixed_distances())?,
            DYNAMIC => {
                let (literals, distances) = dynamic(&mut bits)?;
                block(&mut bits, &mut out, &literals, &distances)?;
            }
            _ => return Err(format!("unknown block kind {kind}")),
        }
        if final_block {
            break;
        }
    }

    Ok((out, bits.byte_position()))
}

/// Block kinds, which are not the numbers the specification gives them.
const FIXED: u32 = 5;
const DYNAMIC: u32 = 6;
const STORED: u32 = 7;

fn stored(bits: &mut Bits, out: &mut Vec<u8>) -> Result<(), String> {
    bits.align();
    let length = bits.bits(16)? as usize;
    for _ in 0..length {
        out.push(bits.bits(8)? as u8);
    }
    Ok(())
}

fn fixed_literals() -> Tree {
    let mut lengths = [0u8; 288];
    for (symbol, length) in lengths.iter_mut().enumerate() {
        *length = match symbol {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    Tree::new(&lengths)
}

fn fixed_distances() -> Tree {
    Tree::new(&[5u8; 30])
}

fn dynamic(bits: &mut Bits) -> Result<(Tree, Tree), String> {
    let literal_count = bits.bits(5)? as usize + 257;
    let distance_count = bits.bits(5)? as usize + 1;
    let code_count = bits.bits(4)? as usize + 4;

    let mut code_lengths = [0u8; 19];
    for &slot in LENGTH_ORDER.iter().take(code_count) {
        code_lengths[slot] = bits.bits(3)? as u8;
    }
    let code_tree = Tree::new(&code_lengths);

    let mut lengths = vec![0u8; literal_count + distance_count];
    let mut at = 0;
    while at < lengths.len() {
        let symbol = code_tree.decode(bits)?;
        match symbol {
            0..=15 => {
                lengths[at] = symbol as u8;
                at += 1;
            }
            16 => {
                let previous = *lengths.get(at.wrapping_sub(1)).ok_or("repeat with nothing before it")?;
                for _ in 0..3 + bits.bits(2)? {
                    if at < lengths.len() {
                        lengths[at] = previous;
                        at += 1;
                    }
                }
            }
            17 => at += 3 + bits.bits(3)? as usize,
            18 => at += 11 + bits.bits(7)? as usize,
            _ => return Err(format!("bad code length symbol {symbol}")),
        }
    }

    Ok((
        Tree::new(&lengths[..literal_count]),
        Tree::new(&lengths[literal_count..]),
    ))
}

fn block(bits: &mut Bits, out: &mut Vec<u8>, literals: &Tree, distances: &Tree) -> Result<(), String> {
    loop {
        let symbol = literals.decode(bits)?;
        match symbol {
            0..=255 => out.push(symbol as u8),
            256 => return Ok(()),
            257..=285 => {
                let slot = symbol as usize - 257;
                let length =
                    LENGTH_BASE[slot] as usize + bits.bits(LENGTH_EXTRA[slot] as u32)? as usize;

                let slot = distances.decode(bits)? as usize;
                if slot >= DISTANCE_BASE.len() {
                    return Err(format!("bad distance code {slot}"));
                }
                let distance =
                    DISTANCE_BASE[slot] as usize + bits.bits(DISTANCE_EXTRA[slot] as u32)? as usize;
                if distance > out.len() {
                    return Err(format!("distance {distance} reaches before the output"));
                }

                let from = out.len() - distance;
                for index in 0..length {
                    let byte = out[from + index];
                    out.push(byte);
                }
            }
            _ => return Err(format!("bad literal/length symbol {symbol}")),
        }
    }
}
