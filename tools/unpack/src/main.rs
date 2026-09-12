//! Reads a Clickteam MMF 1.5 game and writes the package the web runtime loads.

mod audio;
mod bank;
mod chunk;
mod events;
mod fonts;
mod frames;
mod icon;
mod images;
mod installer;
mod json;
mod manifest;
mod zip;
mod objects;
mod png;
mod inflate;
mod pe;

use std::borrow::Cow;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: {} <game.exe>", args[0]);
        return ExitCode::FAILURE;
    }

    let data = match std::fs::read(&args[1]) {
        Ok(data) => data,
        Err(e) => {
            eprintln!("could not read {}: {e}", args[1]);
            return ExitCode::FAILURE;
        }
    };

    let (chunks, header_runtime, exe) = match read_game(&data) {
        Ok(found) => found,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };

    let mut objects = Vec::new();
    if let Some(c) = chunks.iter().find(|c| c.id == objects::FRAME_ITEMS) {
        match objects::read(&c.data) {
            Ok(list) => objects = list,
            Err(e) => println!("objects: {e}"),
        }
    }
    println!("{} objects, {} of them global", objects.len(),
        objects.iter().filter(|o| o.is_global()).count());
    let mut frames = Vec::new();
    for (index, c) in chunks.iter().filter(|c| c.id == frames::FRAME).enumerate() {
        match frames::read(index, &c.data) {
            Ok(frame) => frames.push(frame),
            Err(e) => println!("frame {index}: {e}"),
        }
    }
    println!("{} frames", frames.len());
    for frame in &frames {
        println!("  {:>2} {:>16} {:>5}x{:<5} {} {:>4} instances  {:>7} bytes of events",
            frame.index, frame.name, frame.width, frame.height, frame.background,
            frame.instances.len(), frame.events.len());
    }

    let Some(out) = args.get(2) else {
        println!("(no output given; nothing written)");
        return ExitCode::SUCCESS;
    };

    let sounds = chunks.iter().find(|c| c.id == 26216)
        .map(|c| audio::read_sounds(&c.data)).transpose().unwrap_or_default().unwrap_or_default();
    let music = chunks.iter().find(|c| c.id == 26217)
        .map(|c| audio::read_music(&c.data)).transpose().unwrap_or_default().unwrap_or_default();
    let fonts = chunks.iter().find(|c| c.id == 26215)
        .map(|c| fonts::read(&c.data)).transpose().unwrap_or_default().unwrap_or_default();
    println!("{} fonts", fonts.len());
    for font in &fonts {
        println!("  {:>2}  {:<20} {}px  weight {}{}{}", font.handle, font.face, font.size,
            font.weight,
            if font.italic { " italic" } else { "" },
            if font.underline { " underline" } else { "" });
    }
    let images = chunks.iter().find(|c| c.id == 26214)
        .map(|c| images::read_bank(&c.data)).transpose().unwrap_or_default().unwrap_or_default();

    // The icon comes out of the executable the game was found in, which is the game's own and
    // not the installer's that carried it here.
    let icon = icon::read(&exe);
    match &icon {
        Some(icon) => println!("icon: {}x{}", icon.width, icon.height),
        None => println!("icon: none in the executable"),
    }

    let header = chunks.iter().find(|c| c.id == 8739).map(|c| c.data.clone()).unwrap_or_default();
    let text_of = |id: u16| chunks.iter().find(|c| c.id == id)
        .map(|c| {
            let raw = c.data.split(|&b| b == 0).next().unwrap_or(&c.data);
            String::from_utf8_lossy(raw).into_owned()
        })
        .unwrap_or_default();
    let word_at = |data: &[u8], at: usize| data.get(at..at + 2)
        .map_or(0, |b| u16::from_le_bytes(b.try_into().unwrap()));

    let game = manifest::Game {
        app_name: text_of(8740),
        author: text_of(8741),
        runtime_version: format!("{}.{}", header_runtime.0, header_runtime.1),
        product_build: header_runtime.2,
        window_width: word_at(&header, 8),
        window_height: word_at(&header, 10),
        frame_handles: chunks.iter().find(|c| c.id == 8747).map_or(Vec::new(), |c| {
            c.data.chunks_exact(2).map(|b| u16::from_le_bytes(b.try_into().unwrap())).collect()
        }),
        frames: &frames,
        objects: &objects,
        images: &images,
        fonts: &fonts,
        sounds: &sounds,
        music: &music,
    };

    let mut package = zip::Zip::new();
    let add = |name: String, data: &[u8], package: &mut zip::Zip| {
        if let Err(e) = package.add(&name, data) {
            eprintln!("{name}: {e}");
        }
    };

    add("game.json".into(), game.manifest().as_bytes(), &mut package);
    for frame in &frames {
        let list = events::read(&frame.events).unwrap_or_default();
        let table = manifest::event_table(frame, &list);
        add(format!("events/frame{:02}.json", frame.index), table.as_bytes(), &mut package);
    }
    for image in &images {
        match png::encode(image.width, image.height, &image.rgba) {
            Ok(bytes) => add(format!("images/{}.png", image.handle), &bytes, &mut package),
            Err(e) => eprintln!("image {}: {e}", image.handle),
        }
    }
    // A package carries the game's face along with its data: the icon as the executable wears
    // it, for a page to use as its own, and the two sizes a web app manifest asks for. The
    // maskable one keeps to the middle of its square, since a phone may round or crop the rest.
    if let Some(icon) = &icon {
        let draw = |name: &str, size: u32, rgba: Vec<u8>, package: &mut zip::Zip| {
            match png::encode(size, size, &rgba) {
                Ok(bytes) => add(name.into(), &bytes, package),
                Err(e) => eprintln!("{name}: {e}"),
            }
        };
        match png::encode(icon.width, icon.height, &icon.rgba) {
            Ok(bytes) => add("icon.png".into(), &bytes, &mut package),
            Err(e) => eprintln!("icon.png: {e}"),
        }
        draw("icons/192.png", 192, icon::fitted(icon, 192, 192, [0, 0, 0, 0]), &mut package);
        draw("icons/512.png", 512, icon::fitted(icon, 512, 512, [0, 0, 0, 0]), &mut package);
        draw("icons/maskable.png", 512, icon::fitted(icon, 512, 320, MASKABLE_BACKGROUND), &mut package);
    }
    for sound in &sounds {
        add(format!("sounds/{}.wav", sound.handle), &sound.wav, &mut package);
    }
    for track in &music {
        add(format!("music/{}.mid", track.handle), &track.midi, &mut package);
    }

    let bytes = package.finish();
    if let Err(e) = std::fs::write(out, &bytes) {
        eprintln!("could not write {out}: {e}");
        return ExitCode::FAILURE;
    }
    println!("{out}: {:.1} MB", bytes.len() as f64 / 1048576.0);

    ExitCode::SUCCESS
}

/// Reads a game out of a file, whether that file is the game or the installer holding it.
///
/// The executable the game turned up in comes back with it: it is the game's own, whatever was
/// opened here, and it is where the icon is read from.
fn read_game(data: &[u8]) -> Result<(Vec<chunk::Chunk>, (u16, u16, u32), Cow<'_, [u8]>), String> {
    match game_chunks(data) {
        Ok((chunks, version)) => return Ok((chunks, version, Cow::Borrowed(data))),
        Err(first) => {
            let Some(start) = pe::appended_offset(data) else { return Err(first) };
            println!("not a game; reading it as an installer");
            let files = installer::unpack(data, start)?;
            println!("  {} files inside", files.len());
            for file in files {
                if let Ok((chunks, version)) = game_chunks(&file) {
                    return Ok((chunks, version, Cow::Owned(file)));
                }
            }
            Err("the installer held no Clickteam game".into())
        }
    }
}

/// What a maskable icon sits on, which is the same black the page is.
const MASKABLE_BACKGROUND: [u8; 4] = [0, 0, 0, 255];

/// The chunks of a game: past the executable, past the pack data if there is any, past the
/// header that says what built it.
fn game_chunks(data: &[u8]) -> Result<(Vec<chunk::Chunk>, (u16, u16, u32)), String> {
    let mut at = pe::appended_offset(data).ok_or("nothing is appended to this file")?;

    if data.get(at..at + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap())) == Some(PACK_MARKER) {
        at = chunk::read_all(data, at)?.1;
    }

    let header = GameHeader::read(data, at)?;
    println!("{}", header.describe());
    let version = (header.runtime_version, header.runtime_subversion, header.product_build);
    Ok((chunk::read_all(data, at + GameHeader::SIZE)?.0, version))
}

/// The pack data opens with this chunk id, which is also what marks a file as the older format.
const PACK_MARKER: u16 = 8748;

/// What the game says about itself, ahead of its chunks.
struct GameHeader {
    runtime_version: u16,
    runtime_subversion: u16,
    product_version: u32,
    product_build: u32,
}

impl GameHeader {
    const SIZE: usize = 16;

    fn read(data: &[u8], at: usize) -> Result<Self, String> {
        if data.get(at..at + 4) != Some(b"PAME") {
            return Err(format!("no game header at {at:#x}"));
        }
        let word = |o: usize| u16::from_le_bytes(data[at + o..at + o + 2].try_into().unwrap());
        let long = |o: usize| u32::from_le_bytes(data[at + o..at + o + 4].try_into().unwrap());
        Ok(Self {
            runtime_version: word(4),
            runtime_subversion: word(6),
            product_version: long(8),
            product_build: long(12),
        })
    }

    fn describe(&self) -> String {
        format!(
            "runtime {}.{}, product {} build {}",
            self.runtime_version, self.runtime_subversion, self.product_version, self.product_build
        )
    }
}

