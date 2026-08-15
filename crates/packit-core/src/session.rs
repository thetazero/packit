//! Sender/receiver session layer: RaptorQ fountain over rendered frames.

use crate::framing::{self, FrameHeader, Meta};
use crate::geometry::raw_capacity_bytes;
use crate::render::render_frame;
use crate::rs_layer;
use raptorq::{Decoder, Encoder, EncodingPacket, ObjectTransmissionInformation};
use std::collections::HashSet;

/// Every 8th frame repeats the metadata.
const META_INTERVAL: u64 = 8;

pub fn frame_capacity() -> usize {
    rs_layer::data_capacity(raw_capacity_bytes())
}

/// Payload bytes per frame (frame capacity minus the 21-byte header).
pub fn payload_capacity() -> usize {
    frame_capacity() - framing::HEADER_LEN
}

/// RaptorQ symbol size: one EncodingPacket (4-byte id + one symbol) fills a
/// frame's payload exactly.
pub fn symbol_size() -> u16 {
    (payload_capacity() - 4) as u16
}

pub struct Sender {
    encoder: Encoder,
    oti: [u8; 12],
    file_id: u32,
    meta_payload: Vec<u8>,
    frame_no: u64,
    /// Pre-serialized source packets, cycled; repair packets generated in
    /// growing batches beyond them.
    source: Vec<Vec<u8>>,
    repair: Vec<Vec<u8>>,
    cursor: usize,
    pub source_symbols: u32,
}

impl Sender {
    pub fn create(data: &[u8], name: &str, mime: &str) -> Sender {
        let encoder = Encoder::with_defaults(data, symbol_size());
        let oti_obj: ObjectTransmissionInformation = encoder.get_config();
        let oti = oti_obj.serialize();
        let crc = framing::crc32(data);
        let meta_payload = framing::build_meta(&Meta {
            file_len: data.len() as u64,
            crc,
            name: name.to_string(),
            mime: mime.to_string(),
        });
        let source: Vec<Vec<u8>> = encoder
            .get_encoded_packets(0)
            .into_iter()
            .map(|p| p.serialize())
            .collect();
        let source_symbols = source.len() as u32;
        Sender {
            encoder,
            oti,
            file_id: crc ^ (data.len() as u32),
            meta_payload,
            frame_no: 0,
            source,
            repair: Vec::new(),
            cursor: 0,
            source_symbols,
        }
    }

    fn next_packet(&mut self) -> Vec<u8> {
        let total = self.source.len() + self.repair.len();
        if self.cursor >= total {
            // Extend the repair pool; keep it bounded so long-running senders
            // cycle a finite (but ample) packet set.
            if self.repair.len() < self.source.len() * 8 + 64 {
                let batch = self
                    .encoder
                    .get_encoded_packets((self.repair.len() + self.source.len().max(8)) as u32);
                self.repair = batch
                    .into_iter()
                    .skip(self.source.len())
                    .map(|p| p.serialize())
                    .collect();
            } else {
                self.cursor = 0;
            }
        }
        let total = self.source.len() + self.repair.len();
        let idx = self.cursor % total;
        self.cursor += 1;
        if idx < self.source.len() {
            self.source[idx].clone()
        } else {
            self.repair[idx - self.source.len()].clone()
        }
    }

    /// Render the next frame as 1024x1024 RGBA.
    pub fn next_frame_rgba(&mut self) -> Vec<u8> {
        let is_meta = self.frame_no % META_INTERVAL == META_INTERVAL - 1;
        self.frame_no += 1;
        let payload = if is_meta { self.meta_payload.clone() } else { self.next_packet() };
        let header = FrameHeader { is_meta, file_id: self.file_id, oti: self.oti };
        let bytes = framing::build_frame(&header, &payload, frame_capacity());
        render_frame(&bytes)
    }
}

pub struct ReceiverStatus {
    pub recognized: bool,
    pub packets: u32,
    pub needed: u32,
    pub have_meta: bool,
    pub done: bool,
}

pub struct Receiver {
    file_id: Option<u32>,
    decoder: Option<Decoder>,
    seen: HashSet<Vec<u8>>,
    meta: Option<Meta>,
    file: Option<Vec<u8>>,
    packets: u32,
    needed: u32,
}

impl Default for Receiver {
    fn default() -> Self {
        Self::new()
    }
}

impl Receiver {
    pub fn new() -> Receiver {
        Receiver {
            file_id: None,
            decoder: None,
            seen: HashSet::new(),
            meta: None,
            file: None,
            packets: 0,
            needed: 0,
        }
    }

    pub fn push_rgba(&mut self, rgba: &[u8], w: usize, h: usize) -> ReceiverStatus {
        let recognized = self.ingest(rgba, w, h);
        ReceiverStatus {
            recognized,
            packets: self.packets,
            needed: self.needed,
            have_meta: self.meta.is_some(),
            done: self.done(),
        }
    }

    fn ingest(&mut self, rgba: &[u8], w: usize, h: usize) -> bool {
        let Some(bytes) = crate::decoder::decode_frame(rgba, w, h) else {
            return false;
        };
        let Some((header, payload)) = framing::parse_frame(&bytes) else {
            return false;
        };
        if self.file_id != Some(header.file_id) {
            // New transfer: reset.
            let oti = ObjectTransmissionInformation::deserialize(&header.oti);
            self.file_id = Some(header.file_id);
            self.decoder = Some(Decoder::new(oti));
            self.seen.clear();
            self.meta = None;
            self.file = None;
            self.packets = 0;
            let transfer_len = oti.transfer_length();
            self.needed = transfer_len.div_ceil(symbol_size() as u64).max(1) as u32;
        }
        if header.is_meta {
            self.meta = framing::parse_meta(payload);
            return true;
        }
        if self.file.is_some() {
            return true;
        }
        if !self.seen.insert(payload[..4.min(payload.len())].to_vec()) {
            return true; // duplicate packet id
        }
        let packet = EncodingPacket::deserialize(payload);
        self.packets += 1;
        if let Some(dec) = self.decoder.as_mut() {
            if let Some(data) = dec.decode(packet) {
                self.file = Some(data);
            }
        }
        true
    }

    fn done(&self) -> bool {
        match (&self.file, &self.meta) {
            (Some(f), Some(m)) => {
                f.len() as u64 == m.file_len && framing::crc32(f) == m.crc
            }
            _ => false,
        }
    }

    pub fn file_name(&self) -> Option<String> {
        self.meta.as_ref().map(|m| m.name.clone())
    }

    pub fn file_mime(&self) -> Option<String> {
        self.meta.as_ref().map(|m| m.mime.clone())
    }

    pub fn take_file(&mut self) -> Option<Vec<u8>> {
        if self.done() {
            self.file.take()
        } else {
            None
        }
    }
}
