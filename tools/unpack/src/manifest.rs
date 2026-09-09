//! Building the package the web runtime loads: the manifest, the event tables, and the assets.

use crate::audio::{Music, Sound};
use crate::events::{self, Event};
use crate::frames::Frame;
use crate::fonts::Font;
use crate::images::Image;
use crate::json::Json;
use crate::objects::{self, Object};

/// Names for the bits of an object's flag word, in the order they sit in it.
const OBJECT_FLAGS: [&str; 19] = [
    "DisplayInFront", "Background", "SaveBackground", "RunBeforeFadeIn", "HasMovements",
    "HasAnimations", "TabStop", "WindowProcess", "HasAlterables", "HasSprites",
    "InternalSaveBackground", "DontFollowFrame", "DisplayAsBackground", "DontDestroyIfTooFar",
    "DontInactivateIfTooFar", "InactivateIfTooFar", "HasText", "DontCreateAtStart",
    "DontResetFrameDuration",
];

/// Widened before shifting: there are nineteen names and a `u16` cannot be shifted past
/// fifteen, so shifting one directly wraps the count round and reports the wrong bits.
fn flag_map(names: &[&str], value: u16) -> Json {
    let value = value as u32;
    Json::Object(
        names.iter().enumerate()
            .map(|(bit, name)| (name.to_string(), Json::Bool(value >> bit & 1 != 0)))
            .collect(),
    )
}

pub struct Game<'a> {
    pub app_name: String,
    pub author: String,
    pub runtime_version: String,
    pub product_build: u32,
    pub window_width: u16,
    pub window_height: u16,
    pub frame_handles: Vec<u16>,
    pub frames: &'a [Frame],
    pub objects: &'a [Object],
    pub images: &'a [Image],
    pub fonts: &'a [Font],
    pub sounds: &'a [Sound],
    pub music: &'a [Music],
}

impl Game<'_> {
    pub fn manifest(&self) -> String {
        let frames = self.frames.iter().map(|f| self.frame(f)).collect();
        let objects = self.objects.iter().enumerate().map(|(id, o)| self.object(id, o)).collect();

        Json::object(vec![
            ("appName", Json::text(&self.app_name)),
            ("author", Json::text(&self.author)),
            ("copyright", Json::text("")),
            ("engine", Json::text("MMF 1.5")),
            ("runtimeVersion", Json::text(&self.runtime_version)),
            ("productBuild", Json::int(self.product_build as i64)),
            ("windowWidth", Json::int(self.window_width as i64)),
            ("windowHeight", Json::int(self.window_height as i64)),
            // MMF 1.5 has no frame-rate field: the runtime's rate was fixed at 50.
            ("frameRate", Json::int(50)),
            ("frameHandles", Json::Array(
                self.frame_handles.iter().map(|h| Json::int(*h as i64)).collect())),
            ("globalValues", Json::Array(vec![])),
            ("globalStrings", Json::Array(vec![])),
            ("frames", Json::Array(frames)),
            ("objects", Json::Array(objects)),
            ("sounds", Json::Array(self.sounds.iter().map(|s| Json::object(vec![
                ("handle", Json::int(s.handle as i64)),
                ("name", Json::text(&s.name)),
                ("file", Json::text(format!("{}.wav", s.handle))),
                ("format", Json::text("wav")),
                ("frequency", Json::int(0)),
            ])).collect())),
            ("music", Json::Array(self.music.iter().map(|m| Json::object(vec![
                ("handle", Json::int(m.handle as i64)),
                ("name", Json::text(&m.name)),
                ("file", Json::text(format!("{}.mid", m.handle))),
                ("frequency", Json::int(0)),
            ])).collect())),
            ("fonts", Json::Array(self.fonts.iter().map(|f| Json::object(vec![
                ("handle", Json::int(f.handle as i64)),
                ("face", Json::text(&f.face)),
                ("size", Json::int(f.size as i64)),
                ("weight", Json::int(f.weight as i64)),
                ("italic", Json::Bool(f.italic)),
                ("underline", Json::Bool(f.underline)),
            ])).collect())),
            ("images", Json::Array(self.images.iter().map(|i| Json::object(vec![
                ("handle", Json::int(i.handle as i64)),
                ("width", Json::int(i.width as i64)),
                ("height", Json::int(i.height as i64)),
                ("hotspotX", Json::int(i.hotspot_x as i64)),
                ("hotspotY", Json::int(i.hotspot_y as i64)),
                ("actionPointX", Json::int(i.action_x as i64)),
                ("actionPointY", Json::int(i.action_y as i64)),
                ("graphicMode", Json::int(i.graphic_mode as i64)),
            ])).collect())),
        ])
        .to_string()
    }

    fn frame(&self, frame: &Frame) -> Json {
        Json::object(vec![
            ("index", Json::int(frame.index as i64)),
            ("name", Json::text(&frame.name)),
            ("width", Json::int(frame.width as i64)),
            ("height", Json::int(frame.height as i64)),
            ("background", Json::text(&frame.background)),
            ("layers", Json::Array(vec![])),
            ("instances", Json::Array(frame.instances.iter().map(|i| Json::object(vec![
                ("handle", Json::int(i.handle as i64)),
                ("objectInfo", Json::int(i.object_info as i64)),
                ("x", Json::int(i.x as i64)),
                ("y", Json::int(i.y as i64)),
                ("layer", Json::int(0)),
                ("parentType", Json::int(i.parent_type as i64)),
                ("parentHandle", Json::int(i.parent_handle as i64)),
                // An instance hung off a parent is a template for a Create action to copy, not
                // something the frame places.
                ("flags", Json::object(vec![
                    ("Locked", Json::Bool(false)),
                    ("CreateOnly", Json::Bool(i.parent_type != 0)),
                ])),
            ])).collect())),
            ("eventCount", Json::int(
                events::read(&frame.events).map_or(0, |e| e.len()) as i64)),
            ("events", Json::text(format!("events/frame{:02}.json", frame.index))),
        ])
    }

    fn object(&self, id: usize, object: &Object) -> Json {
        Json::object(vec![
            ("id", Json::int(id as i64)),
            ("handle", Json::int(object.handle as i64)),
            ("name", Json::text(&object.name)),
            ("type", Json::int(object.object_type as i64)),
            ("typeName", Json::text(object.type_name())),
            ("inkEffect", Json::int((object.ink_effect & 0xffff) as i64)),
            ("inkEffectParam", Json::int(object.ink_effect_param as i64)),
            ("headerFlags", Json::object(vec![
                ("GlobalObject", Json::Bool(object.is_global())),
            ])),
            ("detail", self.detail(object)),
        ])
    }

    fn detail(&self, object: &Object) -> Json {
        let p = &object.properties;
        if matches!(object.object_type, 0 | 1) {
            let Some(b) = objects::read_backdrop(p, object.object_type == 0) else {
                return Json::Null;
            };
            let mut fields = vec![
                ("width", Json::int(b.width as i64)),
                ("height", Json::int(b.height as i64)),
                ("obstacleType", Json::int(b.obstacle_type as i64)),
                ("collisionType", Json::int(b.collision_type as i64)),
                ("image", Json::int(b.image as i64)),
            ];
            if let Some(s) = &b.shape {
                fields.extend([
                    ("shape", Json::int(s.shape_type as i64)),
                    ("fillType", Json::int(s.fill_type as i64)),
                    ("color1", Json::text(&s.color1)),
                    ("color2", Json::text(&s.color2)),
                    ("verticalGradient", Json::Bool(s.vertical_gradient)),
                    ("borderSize", Json::int(s.border_size as i64)),
                    ("borderColor", Json::text(&s.border_color)),
                ]);
            }
            return Json::object(fields);
        }

        let Some(common) = objects::read_common(p) else { return Json::Null };
        let counter = objects::read_counter(p);
        Json::object(vec![
            ("flags", flag_map(&OBJECT_FLAGS, common.flags)),
            ("newFlags", Json::object(vec![
                ("VisibleAtStart", Json::Bool(common.new_flags >> 3 & 1 != 0)),
            ])),
            ("preferences", Json::object(vec![])),
            ("animations", Json::Array(common.animations.iter().map(|a| Json::object(vec![
                ("id", Json::int(a.id as i64)),
                ("name", Json::text("")),
                ("directions", Json::Array(a.directions.iter().map(|d| Json::object(vec![
                    ("index", Json::int(d.index as i64)),
                    ("minSpeed", Json::int(d.min_speed as i64)),
                    ("maxSpeed", Json::int(d.max_speed as i64)),
                    ("repeat", Json::int(d.repeat as i64)),
                    ("repeatFrame", Json::int(d.repeat_frame as i64)),
                    ("frames", Json::Array(
                        d.frames.iter().map(|f| Json::int(*f as i64)).collect())),
                ])).collect())),
            ])).collect())),
            ("paragraphs", Json::Array(
                objects::read_paragraphs(p, object.object_type).iter().map(|g| Json::object(vec![
                    ("text", Json::text(&g.text)),
                    ("color", Json::text(&g.color)),
                    ("font", Json::int(g.font as i64)),
                ])).collect())),
            ("movements", Json::Array(
                objects::read_movements(p).iter().enumerate().map(|(i, m)| Json::object(vec![
                    ("name", Json::text(format!("Movement #{i}"))),
                    ("id", Json::int(i as i64)),
                    ("player", Json::int(m.player as i64)),
                    ("type", Json::int(m.kind as i64)),
                    ("startingDirection", Json::int(m.starting_direction as i32 as i64)),
                    ("definition", Json::object({
                        let mut fields = vec![
                            ("Type", Json::int(m.kind as i64)),
                            ("StartingDirection", Json::int(m.starting_direction as i32 as i64)),
                        ];
                        for (name, value) in &m.values {
                            fields.push((name, Json::int(*value)));
                        }
                        if !m.nodes.is_empty() {
                            fields.push(("PathNodes", Json::Array(m.nodes.iter().map(|n| Json::object(vec![
                                ("Speed", Json::int(n.speed as i64)),
                                ("Direction", Json::int(n.direction as i64)),
                                ("Dx", Json::int(n.dx as i64)),
                                ("Dy", Json::int(n.dy as i64)),
                                ("Cos", Json::int(n.cos as i64)),
                                ("Sin", Json::int(n.sin as i64)),
                                ("Length", Json::int(n.length as i64)),
                                ("Pause", Json::int(n.pause as i64)),
                            ])).collect())));
                        }
                        fields
                    })),
                ])).collect())),
            ("alterableValues", Json::Array(vec![])),
            ("counter", Json::object(vec![
                ("initial", Json::int(counter.as_ref().map_or(0, |c| c.initial) as i64)),
                ("minimum", Json::int(counter.as_ref().map_or(0, |c| c.minimum) as i64)),
                ("maximum", Json::int(counter.as_ref().map_or(0, |c| c.maximum) as i64)),
                ("display", Json::int(counter.as_ref().map_or(0, |c| c.display) as i64)),
                ("width", Json::int(counter.as_ref().map_or(0, |c| c.width) as i64)),
                ("height", Json::int(counter.as_ref().map_or(0, |c| c.height) as i64)),
                ("frames", Json::Array(counter.as_ref().map_or(Vec::new(), |c|
                    c.frames.iter().map(|f| Json::int(*f as i64)).collect()))),
                ("inverse", Json::Bool(counter.as_ref().is_some_and(|c| c.inverse))),
                ("image", Json::int(counter.as_ref().map_or(0, |c| c.image) as i64)),
                ("shape", match counter.as_ref().and_then(|c| c.shape.as_ref()) {
                    None => Json::Null,
                    Some(s) => Json::object(vec![
                        ("shape", Json::int(s.shape_type as i64)),
                        ("fillType", Json::int(s.fill_type as i64)),
                        ("color1", Json::text(&s.color1)),
                        ("color2", Json::text(&s.color2)),
                        ("verticalGradient", Json::Bool(s.vertical_gradient)),
                        ("borderSize", Json::int(s.border_size as i64)),
                        ("borderColor", Json::text(&s.border_color)),
                    ]),
                }),
            ])),
            ("alterableStrings", Json::Array(vec![])),
            ("identifier", Json::text(&common.identifier)),
            ("backColor", Json::text(&common.back_color)),
        ])
    }
}

/// One frame's event table, as the runtime reads it.
pub fn event_table(frame: &Frame, events: &[Event]) -> String {
    Json::object(vec![
        ("frame", Json::int(frame.index as i64)),
        ("name", Json::text(&frame.name)),
        ("eventObjects", Json::Array(vec![])),
        ("events", Json::Array(events.iter().enumerate().map(|(index, e)| Json::object(vec![
            ("index", Json::int(index as i64)),
            ("conditions", Json::Array(e.conditions.iter().map(ace).collect())),
            ("actions", Json::Array(e.actions.iter().map(ace).collect())),
        ])).collect())),
    ])
    .to_string()
}

fn ace(a: &events::Ace) -> Json {
    Json::object(vec![
        ("objectType", Json::int(a.object_type as i64)),
        ("num", Json::int(a.num as i64)),
        ("objectInfo", Json::int(a.object_info as i64)),
        ("objectInfoList", Json::int(a.object_info_list as i64)),
        ("negated", Json::Bool(a.negated)),
        ("always", Json::Bool(a.always)),
        ("repeat", Json::Bool(false)),
        ("text", Json::text("")),
        ("parameters", Json::Array(a.parameters.iter().map(|p| Json::object(vec![
            ("code", Json::int(p.code as i64)),
            ("type", Json::text(p.type_name())),
            ("value", Json::text("")),
            ("data", p.data()),
        ])).collect())),
    ])
}
