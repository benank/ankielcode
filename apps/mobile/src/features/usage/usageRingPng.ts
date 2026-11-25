const SIZE = 60;
const HALF = SIZE / 2;
const RADIUS = 22.5;
const HALF_STROKE = 3.75;
const TWO_PI = Math.PI * 2;
const CACHE_LIMIT = 64;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const ringCache = new Map<string, string>();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function parseColor(value: string | undefined, fallback: Rgba): Rgba {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      const a = hex.length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b) && !Number.isNaN(a)) {
        return { r, g, b, a };
      }
    } else if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b) && !Number.isNaN(a)) {
        return { r, g, b, a };
      }
    }
  }
  const rgbMatch =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(trimmed);
  if (rgbMatch) {
    return {
      r: Math.min(255, Math.max(0, Number(rgbMatch[1]))),
      g: Math.min(255, Math.max(0, Number(rgbMatch[2]))),
      b: Math.min(255, Math.max(0, Number(rgbMatch[3]))),
      a: rgbMatch[4] === undefined ? 1 : Math.min(1, Math.max(0, Number(rgbMatch[4]))),
    };
  }
  return fallback;
}

function coverageFromDistance(distance: number): number {
  const edge = HALF_STROKE - distance;
  if (edge <= -0.75) return 0;
  if (edge >= 0.75) return 1;
  return (edge + 0.75) / 1.5;
}

function distanceToArc(dx: number, dy: number, dist: number, angle: number, sweep: number): number {
  if (angle <= sweep) {
    return Math.abs(dist - RADIUS);
  }
  const startX = 0;
  const startY = -RADIUS;
  const endAngle = sweep - Math.PI / 2;
  const endX = Math.cos(endAngle) * RADIUS;
  const endY = Math.sin(endAngle) * RADIUS;
  const dStart = Math.hypot(dx - startX, dy - startY);
  const dEnd = Math.hypot(dx - endX, dy - endY);
  return Math.min(dStart, dEnd);
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < bytes.length; i++) {
    s1 = (s1 + bytes[i]!) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeUint32BE(chunk, 0, data.length);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  writeUint32BE(chunk, 8 + data.length, crc32(chunk, 4, 8 + data.length));
  return chunk;
}

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >>> 18) & 63]!;
    out += BASE64_ALPHABET[(triple >>> 12) & 63]!;
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >>> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63]! : "=";
  }
  return out;
}

function encodeRgbaPng(rawScanlines: Uint8Array): string {
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, SIZE);
  writeUint32BE(ihdr, 4, SIZE);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const ihdrChunk = makeChunk("IHDR", ihdr);

  // Single uncompressed DEFLATE stored block wrapped in zlib framing.
  const len = rawScanlines.length;
  const nlen = ~len & 0xffff;
  const zlib = new Uint8Array(2 + 5 + len + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib[2] = 0x01; // final stored block
  zlib[3] = len & 0xff;
  zlib[4] = (len >>> 8) & 0xff;
  zlib[5] = nlen & 0xff;
  zlib[6] = (nlen >>> 8) & 0xff;
  zlib.set(rawScanlines, 7);
  writeUint32BE(zlib, 7 + len, adler32(rawScanlines));
  const idatChunk = makeChunk("IDAT", zlib);

  const iendChunk = makeChunk("IEND", new Uint8Array(0));
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let offset = 0;
  png.set(signature, offset);
  offset += signature.length;
  png.set(ihdrChunk, offset);
  offset += ihdrChunk.length;
  png.set(idatChunk, offset);
  offset += idatChunk.length;
  png.set(iendChunk, offset);
  return `data:image/png;base64,${toBase64(png)}`;
}

export function usageRingPngUri(input: {
  readonly percent: number | undefined;
  readonly activeColor: string | undefined;
  readonly trackColor: string | undefined;
}): string {
  const rounded =
    input.percent === undefined ? undefined : Math.round(Math.min(100, Math.max(0, input.percent)));
  const key = `${rounded ?? "none"}|${input.activeColor ?? ""}|${input.trackColor ?? ""}`;
  const cached = ringCache.get(key);
  if (cached !== undefined) return cached;

  const active = parseColor(input.activeColor, { r: 255, g: 255, b: 255, a: 1 });
  const trackBase = parseColor(input.trackColor, { r: 142, g: 142, b: 147, a: 1 });
  const track: Rgba = { r: trackBase.r, g: trackBase.g, b: trackBase.b, a: trackBase.a * 0.35 };
  const sweep = rounded === undefined ? 0 : (rounded / 100) * TWO_PI;

  const stride = 1 + SIZE * 4;
  const raw = new Uint8Array(SIZE * stride);
  for (let y = 0; y < SIZE; y++) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0; // filter type None
    const dy = y + 0.5 - HALF;
    for (let x = 0; x < SIZE; x++) {
      const dx = x + 0.5 - HALF;
      const dist = Math.hypot(dx, dy);
      // Angle clockwise from 12 o'clock in [0, 2*PI).
      let angle = Math.atan2(dy, dx) + Math.PI / 2;
      if (angle < 0) angle += TWO_PI;

      let trackCov = coverageFromDistance(Math.abs(dist - RADIUS));
      if (rounded === undefined && trackCov > 0) {
        // 12 evenly spaced dashes matching the SVG dashed empty ring.
        const phase = ((angle / TWO_PI) * 12) % 1;
        if (phase > 0.52) trackCov = 0;
      }

      const activeCov =
        rounded !== undefined && rounded > 0
          ? coverageFromDistance(
              rounded >= 100 ? Math.abs(dist - RADIUS) : distanceToArc(dx, dy, dist, angle, sweep),
            )
          : 0;

      const ta = track.a * trackCov;
      const aa = active.a * activeCov;
      const outA = aa + ta * (1 - aa);
      if (outA <= 0) continue;

      const outR = (active.r * aa + track.r * ta * (1 - aa)) / outA;
      const outG = (active.g * aa + track.g * ta * (1 - aa)) / outA;
      const outB = (active.b * aa + track.b * ta * (1 - aa)) / outA;
      const px = rowOffset + 1 + x * 4;
      raw[px] = Math.round(outR);
      raw[px + 1] = Math.round(outG);
      raw[px + 2] = Math.round(outB);
      raw[px + 3] = Math.round(outA * 255);
    }
  }

  const uri = encodeRgbaPng(raw);
  if (ringCache.size >= CACHE_LIMIT) {
    ringCache.clear();
  }
  ringCache.set(key, uri);
  return uri;
}
