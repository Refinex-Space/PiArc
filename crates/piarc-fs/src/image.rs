//! Recognizes the image formats Pi's `read` tool sends to models, from a file's first bytes.
//!
//! Ported from Pi v1.5.2 `packages/coding-agent/src/utils/mime.ts`
//! (`detectSupportedImageMimeType`), MIT License, Copyright (c) 2025 Mario Zechner. Same
//! signatures and the same exclusions (JPEG with the `0xF7` marker, animated PNG, BMP headers
//! that do not add up), so the delegated `Read` treats exactly the files Pi treats as images.

/// Bytes to read before sniffing, as Pi does.
pub(crate) const SNIFF_BYTES: u64 = 4100;

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// The MIME type of a supported image, or `None`.
pub(crate) fn detect(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0xff, 0xd8, 0xff]) {
        return (head.get(3) != Some(&0xf7)).then_some("image/jpeg");
    }
    if head.starts_with(&PNG_SIGNATURE) {
        return (is_png(head) && !is_animated_png(head)).then_some("image/png");
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    if head.starts_with(b"BM") && is_bmp(head) {
        return Some("image/bmp");
    }
    None
}

fn is_png(head: &[u8]) -> bool {
    head.len() >= 16 && u32_be(head, 8) == 13 && head.get(12..16) == Some(b"IHDR")
}

fn is_animated_png(head: &[u8]) -> bool {
    let mut offset = PNG_SIGNATURE.len();
    while offset + 8 <= head.len() {
        let chunk_length = u32_be(head, offset) as usize;
        match head.get(offset + 4..offset + 8) {
            Some(b"acTL") => return true,
            Some(b"IDAT") => return false,
            _ => {}
        }
        let next = offset.saturating_add(12).saturating_add(chunk_length);
        if next <= offset || next > head.len() {
            return false;
        }
        offset = next;
    }
    false
}

fn is_bmp(head: &[u8]) -> bool {
    if head.len() < 26 {
        return false;
    }
    let declared_size = u32_le(head, 2);
    let pixel_offset = u32_le(head, 10);
    let dib_size = u32_le(head, 14);
    if declared_size != 0 && declared_size < 26 {
        return false;
    }
    if u64::from(pixel_offset) < 14 + u64::from(dib_size) {
        return false;
    }
    if declared_size != 0 && pixel_offset >= declared_size {
        return false;
    }
    let (planes, bits) = if dib_size == 12 {
        (u16_le(head, 22), u16_le(head, 24))
    } else if (40..=124).contains(&dib_size) {
        if head.len() < 30 {
            return false;
        }
        (u16_le(head, 26), u16_le(head, 28))
    } else {
        return false;
    };
    planes == 1 && [1, 4, 8, 16, 24, 32].contains(&bits)
}

fn byte(head: &[u8], index: usize) -> u32 {
    head.get(index).copied().map_or(0, u32::from)
}

fn u16_le(head: &[u8], offset: usize) -> u32 {
    byte(head, offset) | (byte(head, offset + 1) << 8)
}

fn u32_le(head: &[u8], offset: usize) -> u32 {
    u16_le(head, offset) | (u16_le(head, offset + 2) << 16)
}

fn u32_be(head: &[u8], offset: usize) -> u32 {
    (byte(head, offset) << 24)
        | (byte(head, offset + 1) << 16)
        | (byte(head, offset + 2) << 8)
        | byte(head, offset + 3)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(extra_chunk: &[u8; 4]) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&13_u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&[0; 13 + 4]);
        bytes.extend_from_slice(&0_u32.to_be_bytes());
        bytes.extend_from_slice(extra_chunk);
        bytes.extend_from_slice(&[0; 4]);
        bytes
    }

    #[test]
    fn recognizes_the_supported_formats() {
        assert_eq!(detect(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(detect(&[0xff, 0xd8, 0xff, 0xf7]), None);
        assert_eq!(detect(&png(b"IDAT")), Some("image/png"));
        assert_eq!(detect(&png(b"acTL")), None);
        assert_eq!(detect(b"GIF89a...."), Some("image/gif"));
        assert_eq!(detect(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        let mut bmp = b"BM".to_vec();
        bmp.extend_from_slice(&0_u32.to_le_bytes()); // declared size unknown
        bmp.extend_from_slice(&0_u32.to_le_bytes());
        bmp.extend_from_slice(&54_u32.to_le_bytes()); // pixel data offset
        bmp.extend_from_slice(&40_u32.to_le_bytes()); // DIB header size
        bmp.extend_from_slice(&[0; 8]);
        bmp.extend_from_slice(&1_u16.to_le_bytes());
        bmp.extend_from_slice(&24_u16.to_le_bytes());
        assert_eq!(detect(&bmp), Some("image/bmp"));
        assert_eq!(detect(b"plain text"), None);
    }
}
