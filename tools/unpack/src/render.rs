//! The music, played and recorded.
//!
//! A MIDI file is a score: it names General MIDI instruments but carries none of them, so how
//! the music sounded was a matter of what synthesiser the machine had. A browser has none, and
//! a soundfont good enough to be worth having is larger than the rest of the game put together,
//! so each track is played here instead, once, against the soundfont a build fetches, and
//! recorded as Ogg Opus. What the runtime loads is audio like any other sound.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ogg::{PacketWriteEndInfo, PacketWriter};
use rustysynth::{MidiFile, MidiFileSequencer, SoundFont, Synthesizer, SynthesizerSettings};

use crate::audio::Music;

/// Opus works at 48 kHz, so that is what the synthesiser is asked for and nothing resamples.
const RATE: i32 = 48000;

/// 20 ms, the frame length Opus is happiest with.
const FRAME: usize = RATE as usize / 50;

/// Bits per second. A game score in mono holds up well here, and the whole soundtrack of a
/// half-hour game comes to about ten megabytes, which is the price of doing this at all.
const BITRATE: i32 = 48000;

/// Reverb goes on ringing after the last note, so the score is played out this much past its
/// end. Whatever of it is silence gets trimmed off again.
const TAIL: f64 = 2.0;

/// Everything quieter than this counts as silence when trimming the end.
const SILENCE: f32 = 0.001; // -60 dBFS

/// The last of the audio is faded by this much, so a track that loops does not click.
const FADE: usize = RATE as usize / 50;

/// Samples rendered at a time. A track is kept whole to be levelled, but it does not need to
/// be held three times over while it is being made.
const BLOCK: usize = 1 << 14;

/// How many tracks are rendered at once. Rendering is the slow half of packaging a game and the
/// tracks have nothing to do with each other, but each one in flight is holding half a minute
/// or more of audio, so this is a handful rather than every core the machine has.
const AT_ONCE: usize = 4;

/// Peak level a track is brought to. Leaving a decibel of headroom keeps the encoder from
/// having to round anything down, and levelling the tracks against each other matters more
/// here than keeping how loud each one happens to be: they are heard one at a time.
const PEAK: f32 = 0.89;

pub struct Track {
    pub handle: u32,
    pub name: String,
    /// One Ogg Opus file.
    pub audio: Vec<u8>,
}

/// Renders every track, dropping any the synthesiser will not take. The tracks are rendered a
/// few at a time, and reported in their own order however they finish in.
pub fn render_all(music: &[Music], soundfont: &Path) -> Result<Vec<Track>, String> {
    let name = soundfont.display();
    let mut file = std::fs::File::open(soundfont).map_err(|e| format!("{name}: {e}"))?;
    let font = Arc::new(SoundFont::new(&mut file).map_err(|e| format!("{name}: {e:?}"))?);
    println!("rendering {} tracks against {name}", music.len());

    let next = AtomicUsize::new(0);
    let rendered: Mutex<Vec<Result<Vec<u8>, String>>> =
        Mutex::new(music.iter().map(|_| Err("was not reached".to_owned())).collect());
    let at_once = std::thread::available_parallelism().map_or(1, |n| n.get()).clamp(1, AT_ONCE);

    std::thread::scope(|scope| {
        for _ in 0..at_once {
            scope.spawn(|| loop {
                let at = next.fetch_add(1, Ordering::Relaxed);
                let Some(track) = music.get(at) else { return };
                let outcome = render(track, &font);
                rendered.lock().expect("a rendering thread panicked")[at] = outcome;
            });
        }
    });

    let outcomes = rendered.into_inner().expect("a rendering thread panicked");
    let mut tracks = Vec::new();
    for (track, outcome) in music.iter().zip(outcomes) {
        match outcome {
            Ok(audio) => {
                println!("  {:>2} {:>16} {:>7} KB", track.handle, track.name, audio.len() / 1024);
                tracks.push(Track { handle: track.handle, name: track.name.clone(), audio });
            }
            Err(e) => eprintln!("music {} ({}): {e}", track.handle, track.name),
        }
    }
    Ok(tracks)
}

fn render(track: &Music, font: &Arc<SoundFont>) -> Result<Vec<u8>, String> {
    let midi = Arc::new(
        MidiFile::new(&mut track.midi.as_slice()).map_err(|e| format!("{e:?}"))?,
    );

    let settings = SynthesizerSettings::new(RATE);
    let synthesizer = Synthesizer::new(font, &settings).map_err(|e| format!("{e:?}"))?;
    let mut sequencer = MidiFileSequencer::new(synthesizer);
    sequencer.play(&midi, false);

    let samples = ((midi.get_length() + TAIL) * RATE as f64) as usize;
    let mut audio = Vec::with_capacity(samples);
    let mut left = vec![0f32; BLOCK];
    let mut right = vec![0f32; BLOCK];
    while audio.len() < samples {
        let take = BLOCK.min(samples - audio.len());
        sequencer.render(&mut left[..take], &mut right[..take]);
        // The runtime plays music through one channel, and stereo would cost half again as much
        // for a score written for a sound card in a beige box.
        audio.extend(left[..take].iter().zip(&right[..take]).map(|(l, r)| (l + r) * 0.5));
    }

    level(&mut audio);
    if audio.is_empty() {
        return Err("the score plays nothing".to_owned());
    }
    Ok(encode(&audio))
}

/// Trims the silence off the end, fades what is left, and brings the peak up to the same place
/// every other track's is.
fn level(audio: &mut Vec<f32>) {
    let end = audio.iter().rposition(|s| s.abs() > SILENCE).map_or(0, |at| at + 1);
    audio.truncate(end);

    let peak = audio.iter().fold(0f32, |peak, s| peak.max(s.abs()));
    let gain = if peak > 0.0 { PEAK / peak } else { 0.0 };
    for sample in audio.iter_mut() {
        *sample *= gain;
    }

    let fade = FADE.min(audio.len());
    let first = audio.len() - fade;
    for (i, sample) in audio[first..].iter_mut().enumerate() {
        *sample *= 1.0 - (i as f32 / fade as f32);
    }
}

fn encode(audio: &[f32]) -> Vec<u8> {
    let mono = opus::Channels::Mono;
    let mut encoder = opus::Encoder::new(RATE as u32, mono, opus::Application::Audio)
        .expect("opus takes 48 kHz mono");
    encoder.set_bitrate(opus::Bitrate::Bits(BITRATE)).expect("a bitrate opus allows");
    encoder.set_vbr(true).expect("opus is variable bitrate by default");
    // The encoder needs a moment of audio before it can emit any, and a player has to be told
    // how much of the start to throw away again.
    let pre_skip = encoder.get_lookahead().unwrap_or(0) as u16;

    let mut out = Vec::new();
    let mut writer = PacketWriter::new(&mut out);
    let stream = 1;

    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(1); // channels
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&(RATE as u32).to_le_bytes());
    head.extend_from_slice(&0i16.to_le_bytes()); // output gain
    head.push(0); // channel mapping family
    write(&mut writer, head, stream, PacketWriteEndInfo::EndPage, 0);

    let vendor = b"gunner3";
    let mut tags = Vec::with_capacity(24);
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes()); // no comments
    write(&mut writer, tags, stream, PacketWriteEndInfo::EndPage, 0);

    // Every packet is a whole frame, so the last one is padded with silence; the granule
    // position on it is what tells a player where the audio really stops.
    let mut packet = vec![0u8; 4000];
    let mut frame = vec![0f32; FRAME];
    let frames = audio.len().div_ceil(FRAME);
    for index in 0..frames {
        let at = index * FRAME;
        let take = FRAME.min(audio.len() - at);
        frame[..take].copy_from_slice(&audio[at..at + take]);
        frame[take..].fill(0.0);

        let size = encoder.encode_float(&frame, &mut packet).expect("a frame opus can take");
        let last = index + 1 == frames;
        let end = if last {
            PacketWriteEndInfo::EndStream
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        let granule = if last { audio.len() } else { (index + 1) * FRAME } as u64;
        write(&mut writer, packet[..size].to_vec(), stream, end, granule + pre_skip as u64);
    }

    drop(writer);
    out
}

fn write(
    writer: &mut PacketWriter<'_, &mut Vec<u8>>,
    packet: Vec<u8>,
    stream: u32,
    end: PacketWriteEndInfo,
    granule: u64,
) {
    // The writer only fails on its output, and this one is a vector.
    writer.write_packet(packet, stream, end, granule).expect("writing to memory");
}
