//! Synthetic-camera acceptance tests for the tile codec.

use packit_core::decoder::decode_frame;
use packit_core::framing;
use packit_core::geometry::CANVAS;
use packit_core::render::render_frame;
use packit_core::rs_layer;
use packit_core::session::{frame_capacity, Receiver, Sender};
use packit_core::synth::{shoot, Channel};

fn test_payload(seed: u8) -> Vec<u8> {
    let cap = frame_capacity();
    let mut state = seed as u32 | 1;
    (0..cap)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 16) as u8
        })
        .collect()
}

fn plain_channel(scale: f64) -> Channel {
    let s = CANVAS as f64 * scale;
    let m = 40.0;
    Channel {
        out_w: (s + 2.0 * m) as usize,
        out_h: (s + 2.0 * m) as usize,
        quad: [(m, m), (m + s, m), (m + s, m + s), (m, m + s)],
        gain: [1.0; 3],
        offset: [0.0; 3],
        noise: 0.0,
        blur: false,
        seed: 1,
    }
}

#[test]
fn clean_roundtrip_full_scale() {
    let data = test_payload(3);
    let frame = render_frame(&data);
    let ch = plain_channel(1.0);
    let img = shoot(&frame, CANVAS, CANVAS, &ch);
    let decoded = decode_frame(&img, ch.out_w, ch.out_h).expect("decode failed");
    assert_eq!(decoded, data);
}

#[test]
fn perspective_warp_color_shift_noise() {
    let data = test_payload(7);
    let frame = render_frame(&data);
    let ch = Channel {
        out_w: 1250,
        out_h: 1210,
        // Moderate keystone: corners pulled unevenly.
        quad: [(60.0, 55.0), (1195.0, 85.0), (1170.0, 1150.0), (85.0, 1120.0)],
        gain: [1.06, 0.95, 0.9],
        offset: [8.0, -6.0, 10.0],
        noise: 6.0,
        blur: false,
        seed: 99,
    };
    let img = shoot(&frame, CANVAS, CANVAS, &ch);
    let decoded = decode_frame(&img, ch.out_w, ch.out_h).expect("decode failed");
    assert_eq!(decoded, data);
}

#[test]
fn all_four_rotations() {
    let data = test_payload(11);
    let frame = render_frame(&data);
    let base = [(50.0, 50.0), (1150.0, 50.0), (1150.0, 1150.0), (50.0, 1150.0)];
    for r in 0..4 {
        let mut quad = [(0.0, 0.0); 4];
        for i in 0..4 {
            // Source corner i lands at output position (i + r) % 4: the
            // code appears rotated by r * 90 degrees.
            quad[i] = base[(i + r) % 4];
        }
        let ch = Channel {
            out_w: 1200,
            out_h: 1200,
            quad,
            gain: [1.0; 3],
            offset: [0.0; 3],
            noise: 3.0,
            blur: false,
            seed: 5,
        };
        let img = shoot(&frame, CANVAS, CANVAS, &ch);
        let decoded = decode_frame(&img, ch.out_w, ch.out_h)
            .unwrap_or_else(|| panic!("rotation {r} failed"));
        assert_eq!(decoded, data, "rotation {r}");
    }
}

#[test]
fn downscale_limit() {
    let data = test_payload(13);
    let frame = render_frame(&data);
    // Minimum working scale is 0.8: a 2px glyph block needs >= ~1.6 camera
    // pixels; at 0.75 the block grid is sub-Nyquist and decode fails. In
    // practice the receiver needs the code to span >= ~820 camera pixels.
    for scale in [1.0, 0.9, 0.8] {
        let ch = plain_channel(scale);
        let img = shoot(&frame, CANVAS, CANVAS, &ch);
        let ok = decode_frame(&img, ch.out_w, ch.out_h).is_some_and(|d| d == data);
        assert!(ok, "scale {scale} should decode");
    }
    // Canary: if this starts passing, the floor improved — update the docs.
    let ch = plain_channel(0.75);
    let img = shoot(&frame, CANVAS, CANVAS, &ch);
    assert!(
        decode_frame(&img, ch.out_w, ch.out_h).is_none_or(|d| d != data),
        "scale 0.75 unexpectedly decodes now; raise the documented floor"
    );
}

#[test]
fn blur_tolerance() {
    let data = test_payload(17);
    let frame = render_frame(&data);
    let mut ch = plain_channel(1.0);
    ch.blur = true;
    ch.noise = 3.0;
    let img = shoot(&frame, CANVAS, CANVAS, &ch);
    let decoded = decode_frame(&img, ch.out_w, ch.out_h).expect("blurred decode failed");
    assert_eq!(decoded, data);
}

#[test]
fn rs_corrects_scattered_tile_damage() {
    let data = test_payload(19);
    let mut frame = render_frame(&data);
    // Blank out 40 scattered data tiles post-render (~40 corrupt bytes,
    // interleaved across RS blocks).
    let mut state = 12345u32;
    for _ in 0..40 {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        let tx = 16 + (state as usize % 96);
        let ty = 16 + ((state >> 8) as usize % 96);
        for j in 0..8 {
            for i in 0..8 {
                let o = ((ty * 8 + j) * CANVAS + tx * 8 + i) * 4;
                frame[o] = 0;
                frame[o + 1] = 0;
                frame[o + 2] = 0;
            }
        }
    }
    let ch = plain_channel(1.0);
    let img = shoot(&frame, CANVAS, CANVAS, &ch);
    let decoded = decode_frame(&img, ch.out_w, ch.out_h).expect("decode failed");
    assert_eq!(decoded, data);
}

#[test]
fn rejects_blank_and_noise_images() {
    let blank = vec![10u8; 640 * 480 * 4];
    assert!(decode_frame(&blank, 640, 480).is_none());
    let mut state = 77u32;
    let noise: Vec<u8> = (0..640 * 480 * 4)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 12) as u8
        })
        .collect();
    assert!(decode_frame(&noise, 640, 480).is_none());
}

#[test]
fn end_to_end_file_transfer_with_loss() {
    // ~100 KB file through a warped, noisy channel with ~30% frame drop.
    let mut state = 31u32;
    let file: Vec<u8> = (0..100_000)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 16) as u8
        })
        .collect();
    let crc = framing::crc32(&file);
    let mut sender = Sender::create(&file, "photo.jpg", "image/jpeg");
    let mut receiver = Receiver::new();
    let ch = Channel {
        out_w: 1220,
        out_h: 1220,
        quad: [(55.0, 60.0), (1165.0, 75.0), (1150.0, 1160.0), (70.0, 1140.0)],
        gain: [1.03, 0.97, 0.94],
        offset: [5.0, -4.0, 6.0],
        noise: 4.0,
        blur: false,
        seed: 42,
    };
    let mut drop_state = 555u32;
    let mut status_done = false;
    for i in 0..600 {
        let frame = sender.next_frame_rgba();
        drop_state ^= drop_state << 13;
        drop_state ^= drop_state >> 17;
        drop_state ^= drop_state << 5;
        if drop_state % 10 < 3 {
            continue; // dropped frame
        }
        let img = shoot(&frame, CANVAS, CANVAS, &ch);
        let s = receiver.push_rgba(&img, ch.out_w, ch.out_h);
        assert!(s.recognized, "frame {i} not recognized");
        if s.done {
            status_done = true;
            break;
        }
    }
    assert!(status_done, "transfer did not complete");
    assert_eq!(receiver.file_name().as_deref(), Some("photo.jpg"));
    assert_eq!(receiver.file_mime().as_deref(), Some("image/jpeg"));
    let got = receiver.take_file().expect("file not released");
    assert_eq!(got.len(), file.len());
    assert_eq!(framing::crc32(&got), crc);
    assert_eq!(got, file);
}

#[test]
fn direct_self_decode_every_frame() {
    // No camera at all: the receiver must recognize every pristine frame.
    // (Glyph fields can fake the anchor signature at half module size; this
    // caught a real cluster-selection bug.)
    let file: Vec<u8> = (0..50_000).map(|i| ((i * 37 + 11) % 256) as u8).collect();
    let mut sender = Sender::create(&file, "test.bin", "application/octet-stream");
    let mut receiver = Receiver::new();
    for i in 0..40 {
        let rgba = sender.next_frame_rgba();
        let s = receiver.push_rgba(&rgba, CANVAS, CANVAS);
        assert!(s.recognized, "pristine frame {i} not recognized");
        if s.done {
            assert_eq!(receiver.take_file().as_deref(), Some(&file[..]));
            return;
        }
    }
    panic!("transfer did not complete");
}

#[test]
fn capacity_pinning() {
    // ~11.6 KB post-RS per frame at the current geometry.
    assert_eq!(frame_capacity(), rs_layer::data_capacity(11_972));
    assert_eq!(frame_capacity(), 9_632);
}
