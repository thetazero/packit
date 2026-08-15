pub mod decoder;
pub mod framing;
pub mod geometry;
pub mod glyphs;
pub mod homography;
pub mod render;
pub mod rs_layer;
pub mod session;
#[doc(hidden)]
pub mod synth;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub fn frame_capacity() -> u32 {
    session::frame_capacity() as u32
}

#[wasm_bindgen]
pub struct TileSender {
    inner: session::Sender,
}

#[wasm_bindgen]
impl TileSender {
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8], name: &str, mime: &str) -> TileSender {
        TileSender { inner: session::Sender::create(data, name, mime) }
    }

    /// RGBA bytes of the next 1024x1024 frame.
    pub fn next_frame(&mut self) -> Vec<u8> {
        self.inner.next_frame_rgba()
    }

    /// Source symbols in the fountain encoding (~frames a receiver needs).
    pub fn source_symbols(&self) -> u32 {
        self.inner.source_symbols
    }

    pub fn payload_capacity(&self) -> u32 {
        session::payload_capacity() as u32
    }
}

#[wasm_bindgen]
#[derive(Default)]
pub struct TileReceiver {
    inner: session::Receiver,
}

#[wasm_bindgen]
impl TileReceiver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TileReceiver {
        TileReceiver { inner: session::Receiver::new() }
    }

    /// Feed one camera frame; returns a compact JSON status string.
    pub fn push_frame(&mut self, rgba: &[u8], w: u32, h: u32) -> String {
        let s = self.inner.push_rgba(rgba, w as usize, h as usize);
        format!(
            "{{\"recognized\":{},\"packets\":{},\"needed\":{},\"haveMeta\":{},\"done\":{}}}",
            s.recognized, s.packets, s.needed, s.have_meta, s.done
        )
    }

    pub fn file_name(&self) -> Option<String> {
        self.inner.file_name()
    }

    pub fn file_mime(&self) -> Option<String> {
        self.inner.file_mime()
    }

    /// The verified file bytes, once done (consumes them).
    pub fn take_file(&mut self) -> Option<Vec<u8>> {
        self.inner.take_file()
    }
}
