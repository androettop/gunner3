//! Event tables.
//!
//! Not a chunk list like the rest of the format: a container with four-character ASCII tags,
//! holding a run of event groups. A group is a condition list and an action list; each of those
//! is an object, an opcode and a run of parameters, and every one of the three says its own
//! length, so the table can be walked without knowing what any of it means.

pub struct Parameter {
    pub code: u16,
    pub body: Vec<u8>,
}

pub struct Ace {
    pub object_type: i8,
    /// The opcode, normalised. The byte holds 48 where the opcode is 80, and the runtime's own
    /// tables are written in the second numbering, so the shift is applied here rather than
    /// leaving every table to know about it. Only opcodes of 48 or more carry it.
    pub num: i32,
    pub object_info: u16,
    pub object_info_list: u16,
    /// Whether the condition is inverted, and whether it is tested every tick rather than
    /// firing on the moment its state becomes true.
    pub negated: bool,
    pub always: bool,
    pub parameters: Vec<Parameter>,
}

pub struct Event {
    pub conditions: Vec<Ace>,
    pub actions: Vec<Ace>,
}

/// The tag the events sit behind, and how much of the container comes before the list of
/// qualifiers it ends with.
const HEADER: usize = 44;
/// One qualifier, as the header lists them.
const QUALIFIER: usize = 4;

pub fn read(data: &[u8]) -> Result<Vec<Event>, String> {
    if data.len() < HEADER + 2 || &data[..4] != b"ER>>" {
        return Err("not an event table".into());
    }

    // The header ends with the qualifiers the frame's events address: a count, then four bytes
    // each. Gunner 3 declares none in any frame, which left 'ERes' at a fixed offset and the
    // count looking like part of the run-up to it; Gunner 4's levels declare up to four, and
    // reading them as the tag is what made every one of those tables "expected ERes" and come
    // back empty. Counting them out is what tells the two apart.
    let count = u16::from_le_bytes(data[HEADER..HEADER + 2].try_into().unwrap()) as usize;
    let mut at = HEADER + 2 + count * QUALIFIER;
    // 'ERes' wraps 'ERev', which holds the events.
    for tag in [b"ERes", b"ERev"] {
        if data.get(at..at + 4) != Some(&tag[..]) {
            return Err(format!("expected {} at {at:#x}", String::from_utf8_lossy(tag)));
        }
        at += 8;
    }

    let mut events = Vec::new();
    while at + 4 <= data.len() {
        if data.get(at..at + 4) == Some(b"<<ER") {
            break;
        }
        let size = i16::from_le_bytes(data[at..at + 2].try_into().unwrap()).unsigned_abs() as usize;
        if size < 14 || at + size > data.len() {
            break;
        }
        events.push(read_group(&data[at..at + size])?);
        at += size;
    }

    Ok(events)
}

/// A group: how many conditions and how many actions, then the two lists.
fn read_group(data: &[u8]) -> Result<Event, String> {
    let condition_count = data[2] as usize;
    let action_count = data[3] as usize;

    let mut at = 14;
    let mut conditions = Vec::with_capacity(condition_count);
    for _ in 0..condition_count {
        let (ace, size) = read_ace(&data[at..], true)?;
        conditions.push(ace);
        at += size;
    }

    let mut actions = Vec::with_capacity(action_count);
    for _ in 0..action_count {
        let (ace, size) = read_ace(&data[at..], false)?;
        actions.push(ace);
        at += size;
    }

    Ok(Event { conditions, actions })
}

/// Opcodes of 48 or more are recorded 32 short of what everything else calls them.
fn normalise(num: i8) -> i32 {
    let num = num as i32;
    match num {
        48.. => num + 32,
        ..=-48 => num - 32,
        _ => num,
    }
}

/// One condition or action, and how long it was. A condition's header carries two bytes more
/// than an action's.
fn read_ace(data: &[u8], condition: bool) -> Result<(Ace, usize), String> {
    if data.len() < 12 {
        return Err("condition or action is shorter than its header".into());
    }
    let word = |at: usize| u16::from_le_bytes(data[at..at + 2].try_into().unwrap());

    let size = word(0) as usize;
    if size > data.len() {
        return Err(format!("condition or action says it is {size} bytes, past the end"));
    }
    let count = word(10) as usize;
    let header = if condition { 14 } else { 12 };

    let mut parameters = Vec::with_capacity(count);
    let mut at = header;
    for _ in 0..count {
        if at + 4 > size {
            return Err("parameters run past the end of what holds them".into());
        }
        let length = u16::from_le_bytes(data[at..at + 2].try_into().unwrap()) as usize;
        let code = u16::from_le_bytes(data[at + 2..at + 4].try_into().unwrap());
        if length < 4 || at + length > size {
            return Err(format!("parameter of {length} bytes does not fit"));
        }
        parameters.push(Parameter { code, body: data[at + 4..at + length].to_vec() });
        at += length;
    }

    Ok((
        Ace {
            object_type: data[2] as i8,
            num: normalise(data[3] as i8),
            object_info: word(4),
            object_info_list: word(6),
            // Both live in the word at +8: bit 5 of its low byte says the condition is tested
            // every tick, bit 0 of its high byte says it is inverted.
            negated: data[9] & 1 != 0,
            always: data[8] & 0x20 != 0,
            parameters,
        },
        size,
    ))
}

use crate::json::Json;

impl Parameter {
    fn word(&self, at: usize) -> i64 {
        self.body
            .get(at..at + 2)
            .map_or(0, |b| u16::from_le_bytes(b.try_into().unwrap()) as i64)
    }

    fn long(&self, at: usize) -> i64 {
        self.body
            .get(at..at + 4)
            .map_or(0, |b| u32::from_le_bytes(b.try_into().unwrap()) as i64)
    }

    fn string(&self, at: usize) -> String {
        let rest = self.body.get(at..).unwrap_or(&[]);
        let text = rest.split(|&b| b == 0).next().unwrap_or(rest);
        String::from_utf8_lossy(text).into_owned()
    }

    /// The name this parameter's shape goes by, matching what the runtime expects to see.
    pub fn type_name(&self) -> &'static str {
        match self.code {
            1 => "ParameterObject",
            2 => "ParameterTimer",
            6 | 7 => "ParameterSample",
            9 => "ParameterCreate",
            13 => "ParameterEvery",
            16 | 21 => "ParameterPosition",
            18 => "ParameterShoot",
            22 | 23 | 45 => "ParameterExpressions",
            29 => "ParameterInt",
            32 => "ParameterClick",
            38 => "ParameterGroup",
            10 | 14 | 26 | 31 | 43 | 50 => "ParameterShort",
            _ => "Parameter",
        }
    }

    /// The fields behind the parameter, under the names the runtime reads them by.
    pub fn data(&self) -> Json {
        match self.code {
            1 => Json::object(vec![
                ("ObjectInfoList", Json::int(self.word(0))),
                ("ObjectInfo", Json::int(self.word(2))),
                ("ObjectType", Json::int(self.word(4))),
            ]),
            2 => Json::object(vec![
                ("Timer", Json::int(self.long(0))),
                ("Loops", Json::int(self.word(4))),
            ]),
            6 | 7 => Json::object(vec![
                ("Handle", Json::int(self.long(0))),
                ("Name", Json::text(self.string(4))),
            ]),
            13 => Json::object(vec![
                ("Delay", Json::int(self.long(0))),
                ("Compteur", Json::int(self.long(4))),
            ]),
            32 => Json::object(vec![
                ("Button", Json::int(self.word(0))),
                ("IsDouble", Json::int(self.word(2))),
            ]),
            38 => Json::object(vec![
                ("GroupFlags", Json::object(vec![("Value", Json::int(self.word(0)))])),
                ("ID", Json::int(self.word(2))),
                ("Name", Json::text(self.string(4))),
            ]),
            // A place in the frame, or a place on an object: the object it hangs off comes first,
            // then the flags that say how, then the offset.
            9 | 16 | 18 | 21 => self.placement(),
            22 | 23 | 45 => self.expressions(),
            // The short kinds differ only in how wide the number is.
            29 | 31 | 43 | 50 => Json::object(vec![("Value", Json::int(self.long(0) as i32 as i64))]),
            _ => Json::object(vec![("Value", Json::int(self.word(0)))]),
        }
    }

    /// Create, shoot and position parameters share a layout; only the name of the flag word and
    /// what follows the placement differ.
    fn placement(&self) -> Json {
        let flags = match self.code {
            9 => "CreateFlags",
            18 => "ShootFlags",
            _ => "PositionFlags",
        };
        let mut fields = vec![
            (flags, Json::object(vec![("Value", Json::int(self.word(2)))])),
            ("ObjectInfoParent", Json::int(self.word(0))),
            ("X", Json::int(self.word(4) as i16 as i64)),
            ("Y", Json::int(self.word(6) as i16 as i64)),
            ("Slope", Json::int(self.word(8))),
            ("Angle", Json::int(self.word(10))),
            ("Direction", Json::int(self.long(12) as i32 as i64)),
            ("TypeParent", Json::int(self.word(16))),
            ("ObjectInfoList", Json::int(self.word(18))),
            ("Layer", Json::int(self.word(20))),
            // The create parameter names this in the plural; the others do not.
            (if self.code == 9 { "ObjectInstances" } else { "ObjectInstance" },
                Json::int(self.word(22))),
            ("ObjectInfo", Json::int(self.word(24))),
        ];
        if self.code == 18 {
            fields.push(("ShootSpeed", Json::int(self.word(30))));
        }
        Json::object(fields)
    }

    /// A comparison and then a flat run of expression tokens, each saying its own length.
    ///
    /// A token of four bytes is an operator and carries nothing. Longer ones carry either a
    /// value (the system object's token 0 for a number, token 3 for text) or the object the
    /// token reads from.
    fn expressions(&self) -> Json {
        let mut tokens = Vec::new();
        let mut at = 2;
        while at + 4 <= self.body.len() {
            let object_type = self.body[at] as i8 as i64;
            let num = normalise(self.body[at + 1] as i8) as i64;
            let size = self.word(at + 2) as usize;
            if size < 4 || at + size > self.body.len() {
                break;
            }

            let system = object_type == -1;
            let mut expression = Vec::new();
            if system && size > 4 {
                expression.push(("Value", if num == 3 {
                    Json::text(self.string(at + 4))
                } else {
                    Json::int(self.long(at + 4) as i32 as i64)
                }));
            } else if !system && size > 8 {
                expression.push(("Value", Json::int(self.word(at + 8))));
            }

            tokens.push(Json::object(vec![
                ("ObjectType", Json::int(object_type)),
                ("Num", Json::int(num)),
                ("Size", Json::int(size as i64)),
                ("Expression", Json::object(expression)),
                // A four-byte token is an operator: it names no object, and reading one from
                // it reads into whatever token comes next.
                ("ObjectInfo", Json::int(if system || size <= 4 { 0 } else { self.word(at + 4) })),
                ("ObjectInfoList", Json::int(0)),
            ]));
            at += size;
        }

        Json::object(vec![
            ("Comparison", Json::int(self.word(0))),
            ("Expressions", Json::Array(tokens)),
        ])
    }
}
