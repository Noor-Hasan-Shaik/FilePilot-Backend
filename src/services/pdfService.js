const {
  PDFDocument, PDFName, PDFRawStream, PDFArray,
  degrees, rgb, StandardFonts,
} = require("pdf-lib");
const fs = require("fs");
const sharp = require("sharp");
const { outputPathFor } = require("../utils/outputPath");
const logger = require("../utils/logger");

/**
 * Walk the PDF's indirect objects, find embedded JPEG image streams
 * (Filter = DCTDecode), and re-encode each through sharp at a lower quality.
 *
 * This is the only "real" compression knob that doesn't require parsing every
 * PDF colorspace — JPEG streams dominate size in photo-heavy PDFs, and
 * re-encoding them at q=60 typically halves the size with negligible visible
 * loss. We don't touch Flate-encoded (lossless) image streams here because
 * decoding them requires inferring colorspace + bits-per-component from the
 * XObject dictionary, which is a much bigger surface.
 */
async function reencodeJpegImages(pdf, quality) {
  const ctx = pdf.context;
  let processed = 0;
  let originalBytes = 0;
  let newBytes = 0;

  const entries = typeof ctx.enumerateIndirectObjects === "function"
    ? ctx.enumerateIndirectObjects()
    : [];

  for (const [, obj] of entries) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (!dict || typeof dict.get !== "function") continue;

    const subtype = dict.get(PDFName.of("Subtype"));
    if (!subtype || subtype.toString() !== "/Image") continue;

    const filter = dict.get(PDFName.of("Filter"));
    let isJpeg = false;
    if (filter) {
      if (filter.toString() === "/DCTDecode") {
        isJpeg = true;
      } else if (filter instanceof PDFArray) {
        for (let i = 0; i < filter.size(); i++) {
          if (filter.get(i).toString() === "/DCTDecode") { isJpeg = true; break; }
        }
      }
    }
    if (!isJpeg) continue;

    const original = obj.contents;
    if (!original || !original.length) continue;

    try {
      const reencoded = await sharp(Buffer.from(original))
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();

      // Only swap in the re-encoded buffer if it's actually smaller — sharp
      // can output a larger stream for already-aggressively-compressed images.
      if (reencoded.length < original.length) {
        originalBytes += original.length;
        newBytes += reencoded.length;
        obj.contents = reencoded;
        try { dict.set(PDFName.of("Length"), pdf.context.obj(reencoded.length)); } catch {}
        processed += 1;
      }
    } catch (e) {
      logger.warn("Skipping JPEG re-encode", { error: e.message });
    }
  }

  return { processed, originalBytes, newBytes };
}

/**
 * Compress a PDF using pdf-lib + sharp.
 *   "low"    — flate object streams only; preserve metadata
 *   "medium" — also rewrite producer/creator; re-encode embedded JPEGs at q=80
 *   "high"   — also strip title/author/keywords + AcroForm/Outline;
 *              re-encode embedded JPEGs at q=60
 */
exports.compressPdf = async (inputPath, level = "medium") => {
  const bytes = fs.readFileSync(inputPath);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });

  if (level === "medium" || level === "high") {
    try { pdf.setProducer("FilePilot"); } catch {}
    try { pdf.setCreator("FilePilot"); } catch {}
  }
  if (level === "high") {
    try { pdf.setTitle(""); } catch {}
    try { pdf.setAuthor(""); } catch {}
    try { pdf.setSubject(""); } catch {}
    try { pdf.setKeywords([]); } catch {}
    try {
      const catalog = pdf.catalog;
      if (catalog && typeof catalog.delete === "function") {
        catalog.delete("AcroForm");
        catalog.delete("Outlines");
      }
    } catch {
      // ignore — pdf-lib internals vary across versions
    }
  }

  if (level === "medium" || level === "high") {
    const quality = level === "high" ? 60 : 80;
    try {
      const stats = await reencodeJpegImages(pdf, quality);
      if (stats.processed > 0) {
        logger.info("Re-encoded embedded JPEGs", {
          images: stats.processed,
          saved_bytes: stats.originalBytes - stats.newBytes,
          quality,
        });
      }
    } catch (e) {
      logger.warn("JPEG re-encode pass failed", { error: e.message });
    }
  }

  const pdfBytes = await pdf.save({
    useObjectStreams: true,
    addDefaultPage: false,
    objectsPerTick: 200,
  });
  const outputPath = outputPathFor(inputPath, "compressed", ".pdf");
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
};

exports.splitPdf = async (inputPath, pageNum = 0) => {
  const bytes = fs.readFileSync(inputPath);
  const pdf = await PDFDocument.load(bytes);
  if (pageNum >= pdf.getPageCount()) throw new Error("Page number out of range");
  const newPdf = await PDFDocument.create();
  const [page] = await newPdf.copyPages(pdf, [pageNum]);
  newPdf.addPage(page);
  const pdfBytes = await newPdf.save();
  const outputPath = outputPathFor(inputPath, `page${pageNum + 1}`, ".pdf");
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
};

exports.extractPageRange = async (inputPath, start, end) => {
  const bytes = fs.readFileSync(inputPath);
  const pdf = await PDFDocument.load(bytes);
  const total = pdf.getPageCount();
  const from = Math.max(0, start);
  const to = Math.min(total - 1, end);
  const newPdf = await PDFDocument.create();
  const indices = [];
  for (let i = from; i <= to; i++) indices.push(i);
  const pages = await newPdf.copyPages(pdf, indices);
  pages.forEach((p) => newPdf.addPage(p));
  const pdfBytes = await newPdf.save();
  const outputPath = outputPathFor(inputPath, `p${from + 1}-${to + 1}`, ".pdf");
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
};

exports.mergePdfs = async (inputPaths) => {
  const mergedPdf = await PDFDocument.create();
  for (const filePath of inputPaths) {
    const bytes = fs.readFileSync(filePath);
    const pdf = await PDFDocument.load(bytes);
    const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    pages.forEach((page) => mergedPdf.addPage(page));
  }
  const pdfBytes = await mergedPdf.save();
  const outputPath = outputPathFor(inputPaths[0], "merged", ".pdf");
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
};

exports.rotatePdf = async (inputPath, angle = 90) => {
  const bytes = fs.readFileSync(inputPath);
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages();
  for (const page of pages) {
    page.setRotation(degrees(page.getRotation().angle + angle));
  }
  const pdfBytes = await pdf.save();
  const outputPath = outputPathFor(inputPath, "rotated", ".pdf");
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
};

exports.removePages = async (inputPath, pagesToRemove) => {
  const bytes = fs.readFileSync(inputPath);
  const pdf = await PDFDocument.load(bytes);
  const total = pdf.getPageCount();
  const removeSet = new Set(pagesToRemove);
  const keepIndices = [];
  for (let i = 0; i < total; i++) {
    if (!removeSet.has(i)) keepIndices.push(i);
  }
  if (keepIndices.length === 0) throw new Error("Cannot remove all pages");
  const newPdf = await PDFDocument.create();
  const pages = await newPdf.copyPages(pdf, keepIndices);
  pages.forEach((p) => newPdf.addPage(p));
  const pdfBytes = await newPdf.save();
  const outputPath = outputPathFor(inputPath, "trimmed", ".pdf");
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
};

exports.addWatermark = async (inputPath, text) => {
  const bytes = fs.readFileSync(inputPath);
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const fontSize = Math.min(width, height) * 0.08;
    const tw = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, {
      x: (width - tw) / 2,
      y: height / 2,
      size: fontSize,
      font,
      color: rgb(0.75, 0.75, 0.75),
      opacity: 0.35,
      rotate: degrees(45),
    });
  }
  const pdfBytes = await pdf.save();
  const outputPath = outputPathFor(inputPath, "watermarked", ".pdf");
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
};

exports.textToPdf = async (text, outputPath) => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const margin = 50;
  const lineHeight = fontSize * 1.4;

  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") { lines.push(""); continue; }
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      const test = current ? current + " " + word : word;
      if (font.widthOfTextAtSize(test, fontSize) > 595 - margin * 2) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }

  let page = pdf.addPage([595, 842]);
  let y = 842 - margin;
  for (const line of lines) {
    if (y < margin + lineHeight) {
      page = pdf.addPage([595, 842]);
      y = 842 - margin;
    }
    if (line) {
      page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
    }
    y -= lineHeight;
  }

  const pdfBytes = await pdf.save();
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
};

exports.getPdfInfo = async (inputPath) => {
  const bytes = fs.readFileSync(inputPath);
  const pdf = await PDFDocument.load(bytes);
  const stats = fs.statSync(inputPath);
  const firstPage = pdf.getPages()[0];
  const { width, height } = firstPage.getSize();
  return {
    pageCount: pdf.getPageCount(),
    size: stats.size,
    pageWidth: Math.round(width),
    pageHeight: Math.round(height),
  };
};
