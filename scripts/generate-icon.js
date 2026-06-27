/**
 * Generates a 128x128 PNG icon for the DeepSeek Inline Completion extension.
 * Uses only Node.js built-in modules (zlib, buffer) — zero external dependencies.
 *
 * Design: DeepSeek-inspired blue gradient background with a white "DS" monogram
 *          and a subtle code-caret accent (">" shape) indicating code completion.
 *
 * Usage: node scripts/generate-icon.js
 * Output: assets/icon.png
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const WIDTH = 128;
const HEIGHT = 128;

// ---- Color helpers ----
function rgba(r, g, b, a = 255) {
    return [r, g, b, a];
}

// DeepSeek brand-inspired palette
const BG_TOP = rgba(30, 58, 138);       // deep blue
const BG_BOTTOM = rgba(37, 99, 235);     // bright blue
const ACCENT = rgba(59, 130, 246);       // medium blue accent
const WHITE = rgba(255, 255, 255);
const WHITE_SOFT = rgba(255, 255, 255, 220);
const WHITE_DIM = rgba(255, 255, 255, 80);

// ---- Pixel buffer ----
const pixels = Buffer.alloc(WIDTH * HEIGHT * 4, 0);

function setPixel(x, y, color) {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    const idx = (y * WIDTH + x) * 4;
    pixels[idx] = color[0];
    pixels[idx + 1] = color[1];
    pixels[idx + 2] = color[2];
    pixels[idx + 3] = color[3];
}

function getPixel(x, y) {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return rgba(0, 0, 0, 0);
    const idx = (y * WIDTH + x) * 4;
    return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
}

function blend(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
        Math.round(a[3] + (b[3] - a[3]) * t),
    ];
}

// ---- Draw gradient background ----
for (let y = 0; y < HEIGHT; y++) {
    const t = y / (HEIGHT - 1);
    const color = blend(BG_TOP, BG_BOTTOM, t);
    for (let x = 0; x < WIDTH; x++) {
        setPixel(x, y, color);
    }
}

// ---- Draw rounded rectangle (for card/panel effect) ----
function drawRoundedRect(cx, cy, w, h, r, color) {
    for (let y = cy - h / 2; y < cy + h / 2; y++) {
        for (let x = cx - w / 2; x < cx + w / 2; x++) {
            if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;

            // Check rounded corners
            let inside = true;
            if (x < cx - w / 2 + r && y < cy - h / 2 + r) {
                const dx = x - (cx - w / 2 + r);
                const dy = y - (cy - h / 2 + r);
                inside = dx * dx + dy * dy <= r * r;
            } else if (x > cx + w / 2 - r && y < cy - h / 2 + r) {
                const dx = x - (cx + w / 2 - r);
                const dy = y - (cy - h / 2 + r);
                inside = dx * dx + dy * dy <= r * r;
            } else if (x < cx - w / 2 + r && y > cy + h / 2 - r) {
                const dx = x - (cx - w / 2 + r);
                const dy = y - (cy + h / 2 - r);
                inside = dx * dx + dy * dy <= r * r;
            } else if (x > cx + w / 2 - r && y > cy + h / 2 - r) {
                const dx = x - (cx + w / 2 - r);
                const dy = y - (cy + h / 2 - r);
                inside = dx * dx + dy * dy <= r * r;
            }

            if (inside) {
                const existing = getPixel(x, y);
                setPixel(x, y, blend(existing, color, color[3] / 255));
            }
        }
    }
}

// Semi-transparent card in the center
drawRoundedRect(WIDTH / 2, HEIGHT / 2, 90, 90, 16, rgba(255, 255, 255, 15));

// ---- Draw "DS" letters (simple bitmap font) ----
// Each letter is 7 wide x 11 tall, scaled to fit
const LETTER_W = 7;
const LETTER_H = 11;

// Bitmap font data: 1 = filled, 0 = empty
const D_BITMAP = [
    [1,1,1,1,0,0,0],
    [1,0,0,0,1,0,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [1,0,0,0,1,0,0],
    [1,1,1,1,0,0,0],
];

const S_BITMAP = [
    [0,1,1,1,1,0,0],
    [1,0,0,0,0,0,0],
    [1,0,0,0,0,0,0],
    [0,1,0,0,0,0,0],
    [0,0,1,1,0,0,0],
    [0,0,0,0,1,0,0],
    [0,0,0,0,0,1,0],
    [0,0,0,0,0,1,0],
    [1,0,0,0,0,1,0],
    [0,1,0,0,1,0,0],
    [0,0,1,1,0,0,0],
];

function drawLetter(bitmap, originX, originY, scale, color) {
    for (let row = 0; row < LETTER_H; row++) {
        for (let col = 0; col < LETTER_W; col++) {
            if (bitmap[row][col]) {
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) {
                        const px = originX + col * scale + sx;
                        const py = originY + row * scale + sy;
                        setPixel(px, py, color);
                    }
                }
            }
        }
    }
}

const SCALE = 4; // 7*4=28, 11*4=44; D+S+gap = 28+6+28=62, centered in 128
const D_W = LETTER_W * SCALE;
const S_W = LETTER_W * SCALE;
const LETTER_GAP = 8;
const TOTAL_W = D_W + LETTER_GAP + S_W;
const LETTER_Y = Math.round(HEIGHT / 2 - (LETTER_H * SCALE) / 2);

// Draw shadow first
drawLetter(D_BITMAP, Math.round(WIDTH / 2 - TOTAL_W / 2) + 2, LETTER_Y + 2, SCALE, rgba(0, 0, 0, 60));
drawLetter(S_BITMAP, Math.round(WIDTH / 2 - TOTAL_W / 2) + D_W + LETTER_GAP + 2, LETTER_Y + 2, SCALE, rgba(0, 0, 0, 60));

// Draw letters in white
drawLetter(D_BITMAP, Math.round(WIDTH / 2 - TOTAL_W / 2), LETTER_Y, SCALE, WHITE);
drawLetter(S_BITMAP, Math.round(WIDTH / 2 - TOTAL_W / 2) + D_W + LETTER_GAP, LETTER_Y, SCALE, WHITE);

// ---- Draw code-caret accent (">_" at bottom-right) ----
function drawCaret(x, y, size, color) {
    // ">" shape using simple lines
    const cx = x;
    const cy = y;
    for (let i = 0; i < size; i++) {
        const px = cx + i;
        const py1 = cy - i;
        const py2 = cy + i;
        setPixel(px, py1, color);
        setPixel(px, py2, color);
        // Thicken the lines
        setPixel(px, py1 - 1, blend(color, rgba(0,0,0,0), 0.3));
        setPixel(px, py2 + 1, blend(color, rgba(0,0,0,0), 0.3));
    }
    // Underscore
    for (let i = 0; i < size + 4; i++) {
        setPixel(x - 2 + i, y + size + 4, color);
    }
}

drawCaret(92, 90, 10, WHITE_DIM);

// ---- Build PNG ----

// Filter bytes: one 0x00 (None filter) per row, followed by the raw RGBA row
const rawData = Buffer.alloc(HEIGHT * (1 + WIDTH * 4));
for (let y = 0; y < HEIGHT; y++) {
    const rowOffset = y * (1 + WIDTH * 4);
    rawData[rowOffset] = 0x00; // filter: None
    pixels.copy(rawData, rowOffset + 1, y * WIDTH * 4, (y + 1) * WIDTH * 4);
}

const compressed = zlib.deflateSync(rawData, { level: 9 });

// ---- PNG chunks ----
function createChunk(type, data) {
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = crc32(typeAndData);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);
    return Buffer.concat([length, typeAndData, crcBuf]);
}

// CRC32 implementation
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ 0xEDB88320;
            } else {
                crc = crc >>> 1;
            }
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// PNG signature
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// IHDR chunk
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);   // width
ihdr.writeUInt32BE(HEIGHT, 4);  // height
ihdr[8] = 8;                     // bit depth (8 bits per channel)
ihdr[9] = 6;                     // color type (RGBA)
ihdr[10] = 0;                    // compression
ihdr[11] = 0;                    // filter
ihdr[12] = 0;                    // interlace

const png = Buffer.concat([
    signature,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0)),
]);

// ---- Write file ----
const outDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}
const outPath = path.join(outDir, 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`Icon generated: ${outPath} (${png.length} bytes)`);
