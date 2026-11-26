// Images of the preview panel (B3.3, B3.4): screenshots arrive from the main process as PNG data
// URLs; the panel cuts regions out of them, draws annotations on them and turns them into the
// blobs the composer attaches.
import type { BrowserImage } from '../../shared/browser.js';

/** The largest image the composer accepts (Core's `MAX_IMAGE_BYTES`). */
export const ATTACHMENT_IMAGE_BYTES = 5 * 1024 * 1024;

/** The bytes of a base64 data URL. */
export function dataUrlBytes(data: string): Uint8Array<ArrayBuffer> {
  const comma = data.indexOf(',');
  const binary = atob(comma === -1 ? data : data.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function dataUrlBlob(data: string): Blob {
  return new Blob([dataUrlBytes(data)], { type: 'image/png' });
}

/** An image element with `src` loaded. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error('The image did not load'));
    };
    image.src = src;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error('The image could not be encoded'));
        else resolve(blob);
      },
      type,
      quality,
    );
  });
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('The image could not be read'));
    };
    reader.onerror = () => {
      reject(new Error('The image could not be read'));
    };
    reader.readAsDataURL(blob);
  });
}

/** `image` cut to `rect` (image pixels) as a new PNG. */
export async function cropImage(
  image: BrowserImage,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): Promise<BrowserImage> {
  const source = await loadImage(image.data);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(source, rect.x, rect.y, width, height, 0, 0, width, height);
  const blob = await canvasBlob(canvas, 'image/png');
  return { data: await blobDataUrl(blob), width, height };
}

/** The canvas as a PNG data URL with its size. */
export async function canvasImage(canvas: HTMLCanvasElement): Promise<BrowserImage> {
  const blob = await canvasBlob(canvas, 'image/png');
  return { data: await blobDataUrl(blob), width: canvas.width, height: canvas.height };
}

/**
 * A blob the composer can attach: the PNG itself, or a JPEG of it when the PNG is larger than
 * the attachment limit (a long page), scaled down until it fits.
 */
export async function attachableBlob(image: BrowserImage): Promise<Blob> {
  const png = dataUrlBlob(image.data);
  if (png.size <= ATTACHMENT_IMAGE_BYTES) return png;
  const source = await loadImage(image.data);
  let scale = 1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.85);
    if (jpeg.size <= ATTACHMENT_IMAGE_BYTES) return jpeg;
    scale *= 0.7;
  }
  return png;
}

/** The file name extension of an attachable blob. */
export function extensionOf(blob: Blob): string {
  return blob.type === 'image/jpeg' ? 'jpg' : 'png';
}
