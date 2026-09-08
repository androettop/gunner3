//! Writing the zip the runtime loads.

use flate2::write::DeflateEncoder;
use flate2::Compression;
use std::io::Write;

pub struct Zip {
    out: Vec<u8>,
    entries: Vec<Entry>,
}

struct Entry {
    name: String,
    crc: u32,
    compressed: u32,
    uncompressed: u32,
    offset: u32,
}

impl Zip {
    pub fn new() -> Self {
        Self { out: Vec::new(), entries: Vec::new() }
    }

    pub fn add(&mut self, name: &str, data: &[u8]) -> Result<(), String> {
        let offset = self.out.len() as u32;
        let crc = crc32(data);

        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(6));
        encoder.write_all(data).map_err(|e| e.to_string())?;
        let body = encoder.finish().map_err(|e| e.to_string())?;

        self.out.extend_from_slice(b"PK\x03\x04");
        self.out.extend_from_slice(&[20, 0, 0, 0, 8, 0, 0, 0, 0, 0]);
        self.out.extend_from_slice(&crc.to_le_bytes());
        self.out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        self.out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        self.out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out.extend_from_slice(name.as_bytes());
        self.out.extend_from_slice(&body);

        self.entries.push(Entry {
            name: name.to_string(),
            crc,
            compressed: body.len() as u32,
            uncompressed: data.len() as u32,
            offset,
        });
        Ok(())
    }

    pub fn finish(mut self) -> Vec<u8> {
        let start = self.out.len() as u32;
        for entry in &self.entries {
            self.out.extend_from_slice(b"PK\x01\x02");
            self.out.extend_from_slice(&[20, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0]);
            self.out.extend_from_slice(&entry.crc.to_le_bytes());
            self.out.extend_from_slice(&entry.compressed.to_le_bytes());
            self.out.extend_from_slice(&entry.uncompressed.to_le_bytes());
            self.out.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
            self.out.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            self.out.extend_from_slice(&entry.offset.to_le_bytes());
            self.out.extend_from_slice(entry.name.as_bytes());
        }
        let size = self.out.len() as u32 - start;

        self.out.extend_from_slice(b"PK\x05\x06");
        self.out.extend_from_slice(&[0, 0, 0, 0]);
        self.out.extend_from_slice(&(self.entries.len() as u16).to_le_bytes());
        self.out.extend_from_slice(&(self.entries.len() as u16).to_le_bytes());
        self.out.extend_from_slice(&size.to_le_bytes());
        self.out.extend_from_slice(&start.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out
    }
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}
