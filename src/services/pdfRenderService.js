const fs = require("fs");
const path = require("path");
const { createCanvas } = require("canvas");
const JSZip = require("jszip");
const { outputPathFor } = require("../utils/outputPath");

// pdfjs-dist v3 legacy CJS build. We pin v3 so we can `require()` from CJS;
// v4+ ships only ESM under build/.
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

// pdfjs needs to fetch the PDF "Standard 14" fonts at render time for documents
// that don't embed their own fonts. Point it at the local copy that ships with
// pdfjs-dist (this is the right answer in Node — no network fetch).
const STANDARD_FONTS_URL =
  "file://" + path.dirname(require.resolve("pdfjs-dist/legacy/build/pdf.js")) + "/../../standard_fonts/";
const CMAP_URL =
  "file://" + path.dirname(require.resolve("pdfjs-dist/legacy/build/pdf.js")) + "/../../cmaps/";

const ABSOLUTE_MAX_PAGES = 100;
const MAX_DIMENSION = 8192;

/**
 * Parse a page-selection string into a sorted, deduplicated 1-based array.
 *
 *   "all"      → [1..total]
 *   "1,3,5"    → [1,3,5]
 *   "2-5"      → [2,3,4,5]
 *   "1,4-6,9"  → [1,4,5,6,9]
 *
 * Any page outside [1..total] is dropped silently rather than erroring — that
 * keeps the API forgiving for "give me pages 1..10" on a 7-page document.
 */
function parsePageSelection(spec, total) {
  if (!spec || spec === "all") {
    const out = [];
    for (let i = 1; i <= total; i++) out.push(i);
    return out;
  }
  const set = new Set();
  for (const part of String(spec).split(",")) {
    const range = part.trim();
    if (!range) continue;
    const m = range.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    const [a, b] = start <= end ? [start, end] : [end, start];
    for (let p = a; p <= b; p++) {
      if (p >= 1 && p <= total) set.add(p);
    }
  }
  return [...set].sort((a, b) => a - b);
}

async function loadDocument(inputPath) {
  const data = new Uint8Array(fs.readFileSync(inputPath));
  return pdfjs.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONTS_URL,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    disableFontFace: true, // we render via node-canvas, no @font-face support
    verbosity: 0,
  }).promise;
}

async function renderPageToBuffer(doc, pageNum, { format, scale, jpegQuality }) {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  // Guard against unbounded canvas allocation on huge pages × large scale.
  let safeScale = scale;
  while ((viewport.width > MAX_DIMENSION || viewport.height > MAX_DIMENSION) && safeScale > 0.5) {
    safeScale *= 0.75;
    const v = page.getViewport({ scale: safeScale });
    if (v.width <= MAX_DIMENSION && v.height <= MAX_DIMENSION) {
      viewport.width = v.width;
      viewport.height = v.height;
      viewport.transform = v.transform;
      break;
    }
  }

  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext("2d");
  // White background — most PDFs assume paper-white. Without this we'd get
  // transparent pixels for PNG output, which looks broken for documents.
  context.fillStyle = "white";
  context.fillRect(0, 0, viewport.width, viewport.height);

  await page.render({ canvasContext: context, viewport }).promise;

  if (format === "jpeg" || format === "jpg") {
    return canvas.toBuffer("image/jpeg", { quality: jpegQuality });
  }
  return canvas.toBuffer("image/png");
}

/**
 * Render PDF pages to images.
 *
 * Options:
 *   format       "jpg" | "png"
 *   pages        "all" | "1,3,5" | "2-7" (1-based)
 *   scale        rasterization scale; 2 ≈ 144 DPI; 3 ≈ 216 DPI; capped at 4
 *   jpegQuality  0..1
 *
 * Returns the path to a single image (if exactly 1 page rendered) or a zip
 * archive containing one image per rendered page.
 */
exports.pdfToImages = async (
  inputPath,
  { format = "jpg", pages = "all", scale = 2, jpegQuality = 0.85 } = {}
) => {
  const fmt = format === "png" ? "png" : "jpeg";
  const ext = fmt === "png" ? "png" : "jpg";
  const safeScale = Math.max(0.5, Math.min(4, Number(scale) || 2));
  const safeJpegQ = Math.max(0.3, Math.min(1, Number(jpegQuality) || 0.85));

  const doc = await loadDocument(inputPath);
  try {
    const total = doc.numPages;
    const selected = parsePageSelection(pages, total);
    if (selected.length === 0) {
      const err = new Error("No valid pages in selection");
      err.status = 400;
      throw err;
    }
    if (selected.length > ABSOLUTE_MAX_PAGES) {
      const err = new Error(`Too many pages selected (${selected.length}); max ${ABSOLUTE_MAX_PAGES} per request`);
      err.status = 413;
      throw err;
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));

    if (selected.length === 1) {
      const buf = await renderPageToBuffer(doc, selected[0], { format: fmt, scale: safeScale, jpegQuality: safeJpegQ });
      const outPath = outputPathFor(inputPath, `p${selected[0]}`, `.${ext}`);
      fs.writeFileSync(outPath, buf);
      return { outputPath: outPath, pageCount: 1 };
    }

    const zip = new JSZip();
    for (const pageNum of selected) {
      const buf = await renderPageToBuffer(doc, pageNum, { format: fmt, scale: safeScale, jpegQuality: safeJpegQ });
      zip.file(`${baseName}_p${pageNum}.${ext}`, buf);
    }
    const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const outPath = outputPathFor(inputPath, ext, ".zip");
    fs.writeFileSync(outPath, zipBuf);
    return { outputPath: outPath, pageCount: selected.length };
  } finally {
    try { await doc.destroy(); } catch {}
  }
};
