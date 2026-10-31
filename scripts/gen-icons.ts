// Draws the app icons as PNG files with no image library: a green tile with a white chat bubble.
// Run with `npm run icons`; the output goes to client/public/icons.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

type Rgba = [number, number, number, number];
type Shape = (x: number, y: number) => boolean;

const GREEN: Rgba = [0, 168, 132, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function roundedRect(cx: number, cy: number, w: number, h: number, r: number): Shape {
  return (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - (w / 2 - r), 0);
    const dy = Math.max(Math.abs(y - cy) - (h / 2 - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
}

function circle(cx: number, cy: number, r: number): Shape {
  return (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function triangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): Shape {
  const sign = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  return (x, y) => {
    const d1 = sign(x, y, ax, ay, bx, by);
    const d2 = sign(x, y, bx, by, cx, cy);
    const d3 = sign(x, y, cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
}

const union = (...shapes: Shape[]): Shape => (x, y) => shapes.some((s) => s(x, y));

/** Layers are painted in order on a 0..1 canvas. Each pixel is supersampled 4x4 for smooth edges. */
function render(size: number, layers: Array<[Shape, Rgba]>): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          let color: Rgba = [0, 0, 0, 0];
          for (const [shape, fill] of layers) if (shape(x, y)) color = fill;
          r += color[0] * color[3]; g += color[1] * color[3]; b += color[2] * color[3]; a += color[3];
        }
      }
      const i = (py * size + px) * 4;
      pixels[i] = a ? Math.round(r / a) : 0;
      pixels[i + 1] = a ? Math.round(g / a) : 0;
      pixels[i + 2] = a ? Math.round(b / a) : 0;
      pixels[i + 3] = Math.round(a / (samples * samples));
    }
  }
  return encodePng(size, pixels);
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The bubble, scaled around the centre so maskable icons keep it inside the safe zone. */
function bubble(scale: number): Array<[Shape, Rgba]> {
  const s = (v: number) => 0.5 + (v - 0.5) * scale;
  const body = union(
    roundedRect(s(0.5), s(0.47), 0.56 * scale, 0.42 * scale, 0.12 * scale),
    triangle(s(0.28), s(0.6), s(0.4), s(0.66), s(0.24), s(0.78)),
  );
  const dots = [0.37, 0.5, 0.63].map((x) => circle(s(x), s(0.47), 0.045 * scale));
  return [[body, WHITE], ...dots.map((d): [Shape, Rgba] => [d, GREEN])];
}

const outDir = path.resolve('client', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const tile: [Shape, Rgba] = [roundedRect(0.5, 0.5, 1, 1, 0.22), GREEN];
const fullBleed: [Shape, Rgba] = [() => true, GREEN];
const outputs: Record<string, [number, Array<[Shape, Rgba]>]> = {
  'icon-192.png': [192, [tile, ...bubble(1)]],
  'icon-512.png': [512, [tile, ...bubble(1)]],
  'maskable-512.png': [512, [fullBleed, ...bubble(0.75)]],
  'apple-touch-icon.png': [180, [fullBleed, ...bubble(0.85)]],
  // Android draws the badge as a white silhouette in the status bar, so it is the bubble alone.
  'badge-72.png': [72, bubble(1.15).slice(0, 1)],
};

for (const [name, [size, layers]] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(outDir, name), render(size, layers));
  console.log(`wrote ${path.join('client', 'public', 'icons', name)}`);
}
