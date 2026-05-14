const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const router = express.Router();

const { OUTPUTS_DIR } = require("../config/upload");
const { optionalAuth } = require("../middleware/auth");
const { createDownloadToken } = require("./download");
const { removeFile } = require("../utils/cleanup");
const { errorLogs } = require("../models/db");
const { safeJsonParse, clampInt, clampFloat, oneOf } = require("../utils/validators");
const { safeFilename } = require("../utils/sanitize");
const { toolGuard, recordUsage } = require("../services/limits");
const { registerFile } = require("../utils/storageManager");

const pdfService = require("../services/pdfService");
const pdfRenderService = require("../services/pdfRenderService");
const imageService = require("../services/imageService");
const docxService = require("../services/docxService");
const xlsxService = require("../services/xlsxService");
const mediaService = require("../services/mediaService");
const officeService = require("../services/officeService");

function origName(req, fallback) {
  return safeFilename(req.file && req.file.originalname, fallback);
}

// Resolve the effective tool route for this request:
// frontend may send `X-Tool-Route` to disambiguate when one API endpoint
// serves multiple frontend tools (e.g. /image/convert).
function resolveToolRoute(req, defaultRoute) {
  const header = req.get("X-Tool-Route");
  if (header && typeof header === "string" && header.startsWith("/tool/") && header.length < 100) {
    return header;
  }
  return defaultRoute;
}

// Helper: generate output path in outputs/ directory
function outputPath(ext) {
  const name = `${Date.now()}_${crypto.randomBytes(8).toString("hex")}${ext}`;
  return path.join(OUTPUTS_DIR, name);
}

// Helper: full middleware chain for a tool-bound processing endpoint.
// kind: "single" | "multiple" | "text" (no upload)
function processHandler(defaultToolRoute, kind, handler) {
  // Resolve route + apply guard at request time so X-Tool-Route can override.
  const resolveAndGuard = (req, res, next) => {
    const toolRoute = resolveToolRoute(req, defaultToolRoute);
    const chain = toolGuard(toolRoute, kind);
    let i = 0;
    const run = (err) => {
      if (err) return next(err);
      const mw = chain[i++];
      if (!mw) return next();
      mw(req, res, run);
    };
    run();
  };

  return [
    optionalAuth,
    resolveAndGuard,
    async (req, res, next) => {
      const inputFiles = [];
      let success = false;
      try {
        if (req.file) inputFiles.push(req.file.path);
        if (req.files) req.files.forEach((f) => inputFiles.push(f.path));

        const result = await handler(req, res);

        if (result && result.skipResponse) {
          success = true;
          return;
        }

        if (!result || !result.outputPath) {
          return res.status(500).json({ error: "Processing failed" });
        }

        // Register the output file with the storage manager so it is subject
        // to plan-based retention + total-disk LRU eviction.
        registerFile(result.outputPath, {
          kind: "output",
          userId: req.user?.id || null,
          plan: req.userPlan || null,
          toolRoute: req.toolRoute || null,
        });

        const token = createDownloadToken(result.outputPath, result.filename, {
          userId: req.user?.id || null,
        });
        success = true;
        res.json({
          success: true,
          downloadUrl: `/api/download/${token}`,
          filename: result.filename,
          size: fs.statSync(result.outputPath).size,
        });
      } catch (err) {
        errorLogs.create({
          message: err.message,
          tool: req.toolRoute || req.path,
          user_id: req.user?.id || null,
        });
        next(err);
      } finally {
        inputFiles.forEach(removeFile);
        if (success) recordUsage(req);
      }
    },
  ];
}

// ─── PDF Routes ──────────────────────────────────────

router.post(
  "/pdf/compress",
  ...processHandler("/tool/pdf-compress", "single", async (req) => {
    const level = oneOf(req.body.level, ["low", "medium", "high"], "medium");
    const result = await pdfService.compressPdf(req.file.path, level);
    return { outputPath: result, filename: `compressed_${origName(req, "file.pdf")}` };
  })
);

router.post(
  "/pdf/merge",
  ...processHandler("/tool/pdf-merge", "multiple", async (req) => {
    if (!req.files || req.files.length < 2) {
      const err = new Error("At least 2 PDF files are required"); err.status = 400; throw err;
    }
    const paths = req.files.map((f) => f.path);
    const result = await pdfService.mergePdfs(paths);
    return { outputPath: result, filename: "merged.pdf" };
  })
);

router.post(
  "/pdf/split",
  ...processHandler("/tool/pdf-split", "single", async (req) => {
    const ranges = safeJsonParse(req.body.ranges, []);
    if (!Array.isArray(ranges) || ranges.length === 0) {
      const err = new Error("Page ranges are required"); err.status = 400; throw err;
    }
    const r = ranges[0];
    if (!r || typeof r.start !== "number" || typeof r.end !== "number" || r.start < 0 || r.end < r.start) {
      const err = new Error("Invalid page range"); err.status = 400; throw err;
    }

    if (r.start === r.end) {
      const result = await pdfService.splitPdf(req.file.path, r.start);
      return { outputPath: result, filename: `page_${r.start + 1}.pdf` };
    }

    const result = await pdfService.extractPageRange(req.file.path, r.start, r.end);
    return { outputPath: result, filename: `pages_${r.start + 1}-${r.end + 1}.pdf` };
  })
);

router.post(
  "/pdf/rotate",
  ...processHandler("/tool/rotate-pdf", "single", async (req) => {
    const angle = oneOf(clampInt(req.body.angle, 90, -360, 360), [-270, -180, -90, 0, 90, 180, 270, 360], 90);
    const result = await pdfService.rotatePdf(req.file.path, angle);
    return { outputPath: result, filename: `rotated_${origName(req, "file.pdf")}` };
  })
);

router.post(
  "/pdf/watermark",
  ...processHandler("/tool/add-watermark", "single", async (req) => {
    let text = typeof req.body.text === "string" ? req.body.text : "WATERMARK";
    text = text.slice(0, 200) || "WATERMARK";
    const result = await pdfService.addWatermark(req.file.path, text);
    return { outputPath: result, filename: `watermarked_${origName(req, "file.pdf")}` };
  })
);

router.post(
  "/pdf/remove-pages",
  ...processHandler("/tool/remove-pages", "single", async (req) => {
    const pages = safeJsonParse(req.body.pages, []);
    if (!Array.isArray(pages) || pages.length === 0 || !pages.every((p) => Number.isInteger(p) && p >= 0)) {
      const err = new Error("Valid page indices are required"); err.status = 400; throw err;
    }
    const result = await pdfService.removePages(req.file.path, pages);
    return { outputPath: result, filename: `trimmed_${origName(req, "file.pdf")}` };
  })
);

router.post(
  "/pdf/text-to-pdf",
  optionalAuth,
  express.json({ limit: "1mb" }),
  (req, res, next) => {
    const toolRoute = resolveToolRoute(req, "/tool/text-to-pdf");
    const chain = toolGuard(toolRoute, "text");
    let i = 0;
    const run = (err) => {
      if (err) return next(err);
      const mw = chain[i++];
      if (!mw) return next();
      mw(req, res, run);
    };
    run();
  },
  async (req, res, next) => {
    let success = false;
    try {
      const { text } = req.body || {};
      if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "Text is required" });
      }
      if (text.length > 500_000) {
        return res.status(413).json({ error: "Text too long" });
      }

      const outPath = outputPath(".pdf");
      await pdfService.textToPdf(text, outPath);

      registerFile(outPath, {
        kind: "output",
        userId: req.user?.id || null,
        plan: req.userPlan || null,
        toolRoute: req.toolRoute || "/tool/text-to-pdf",
      });

      const token = createDownloadToken(outPath, "text_document.pdf", {
        userId: req.user?.id || null,
      });
      success = true;
      res.json({
        success: true,
        downloadUrl: `/api/download/${token}`,
        filename: "text_document.pdf",
        size: fs.statSync(outPath).size,
      });
    } catch (err) {
      errorLogs.create({ message: err.message, tool: req.toolRoute || "/pdf/text-to-pdf", user_id: req.user?.id || null });
      next(err);
    } finally {
      if (success) recordUsage(req);
    }
  }
);

router.post(
  "/pdf/info",
  ...processHandler("/tool/pdf-compress", "single", async (req, res) => {
    const info = await pdfService.getPdfInfo(req.file.path);
    res.json({ success: true, ...info });
    return { skipResponse: true };
  })
);

// ─── Image Routes ────────────────────────────────────

router.post(
  "/image/compress",
  ...processHandler("/tool/image-compress", "single", async (req) => {
    const quality = clampInt(req.body.quality, 70, 1, 100);
    const result = await imageService.compressImage(req.file.path, quality);
    return { outputPath: result, filename: `compressed_${origName(req, "image")}` };
  })
);

router.post(
  "/image/resize",
  ...processHandler("/tool/image-resize", "single", async (req) => {
    const width = clampInt(req.body.width, 800, 1, 20000);
    const height = clampInt(req.body.height, 600, 1, 20000);
    const result = await imageService.resizeImage(req.file.path, width, height);
    return { outputPath: result, filename: `resized_${origName(req, "image")}` };
  })
);

router.post(
  "/image/convert",
  ...processHandler("/tool/convert-png-jpg", "single", async (req) => {
    const format = oneOf(req.body.format, ["png", "jpeg", "jpg", "webp", "tiff"], "png");
    const result = await imageService.convertToFormat(req.file.path, format);
    const ext = format === "jpeg" ? "jpg" : format;
    const safeName = origName(req, "image").replace(/\.[^.]+$/, `.${ext}`);
    return { outputPath: result, filename: safeName };
  })
);

router.post(
  "/image/rotate",
  ...processHandler("/tool/image-compress", "single", async (req) => {
    const degrees = clampInt(req.body.degrees, 90, -360, 360);
    const result = await imageService.rotateImage(req.file.path, degrees);
    return { outputPath: result, filename: `rotated_${origName(req, "image")}` };
  })
);

router.post(
  "/image/grayscale",
  ...processHandler("/tool/image-compress", "single", async (req) => {
    const result = await imageService.grayscaleImage(req.file.path);
    return { outputPath: result, filename: `bw_${origName(req, "image")}` };
  })
);

router.post(
  "/image/flip",
  ...processHandler("/tool/image-compress", "single", async (req) => {
    const direction = oneOf(req.body.direction, ["horizontal", "vertical"], "horizontal");
    const result = await imageService.flipImage(req.file.path, direction);
    return { outputPath: result, filename: `flipped_${origName(req, "image")}` };
  })
);

router.post(
  "/image/blur",
  ...processHandler("/tool/image-compress", "single", async (req) => {
    const sigma = clampFloat(req.body.sigma, 5, 0.3, 100);
    const result = await imageService.blurImage(req.file.path, sigma);
    return { outputPath: result, filename: `blurred_${origName(req, "image")}` };
  })
);

router.post(
  "/image/crop-square",
  ...processHandler("/tool/crop-image", "single", async (req) => {
    const result = await imageService.cropToSquare(req.file.path);
    return { outputPath: result, filename: `cropped_${origName(req, "image")}` };
  })
);

router.post(
  "/image/merge",
  ...processHandler("/tool/image-merger", "multiple", async (req) => {
    if (!req.files || req.files.length < 2) {
      const err = new Error("At least 2 images are required"); err.status = 400; throw err;
    }
    const direction = oneOf(req.body.direction, ["horizontal", "vertical"], "horizontal");
    const paths = req.files.map((f) => f.path);
    const result = await imageService.mergeImages(paths, direction);
    return { outputPath: result, filename: "merged_image.jpg" };
  })
);

router.post(
  "/image/to-pdf",
  ...processHandler("/tool/image-to-pdf", "multiple", async (req) => {
    if (!req.files || req.files.length === 0) {
      const err = new Error("At least 1 image is required"); err.status = 400; throw err;
    }
    const paths = req.files.map((f) => f.path);
    const result = await imageService.imagesToPdf(paths);
    return { outputPath: result, filename: "images.pdf" };
  })
);

router.post(
  "/image/remove-bg",
  ...processHandler("/tool/remove-bg", "single", async (req) => {
    const result = await imageService.removeBackground(req.file.path, {
      color: typeof req.body.color === "string" ? req.body.color : undefined,
      tolerance: req.body.tolerance,
      feather: req.body.feather,
    });
    const safeName = origName(req, "image").replace(/\.[^.]+$/, ".png");
    return { outputPath: result, filename: `nobg_${safeName}` };
  })
);

router.post(
  "/image/enhance",
  ...processHandler("/tool/image-enhancer", "single", async (req) => {
    const brightnessPct = clampInt(req.body.brightness, 110, 20, 300);
    const contrastPct = clampInt(req.body.contrast, 115, 20, 300);
    const saturationPct = clampInt(req.body.saturation, 120, 0, 400);
    const sharpnessSigma = clampFloat(req.body.sharpness, 1, 0, 5);
    const result = await imageService.enhanceImage(req.file.path, {
      brightnessPct,
      contrastPct,
      saturationPct,
      sharpnessSigma,
    });
    return { outputPath: result, filename: `enhanced_${origName(req, "image.jpg")}` };
  })
);

router.post(
  "/image/info",
  ...processHandler("/tool/image-compress", "single", async (req, res) => {
    const info = await imageService.getImageInfo(req.file.path);
    res.json({ success: true, ...info });
    return { skipResponse: true };
  })
);

// ─── Conversion Routes ──────────────────────────────

router.post(
  "/convert/jpg-to-pdf",
  ...processHandler("/tool/jpg-to-pdf", "multiple", async (req) => {
    if (!req.files || req.files.length === 0) {
      const err = new Error("At least 1 image file is required"); err.status = 400; throw err;
    }
    const paths = req.files.map((f) => f.path);
    const result = await imageService.imagesToPdf(paths);
    return { outputPath: result, filename: "converted.pdf" };
  })
);

// ─── PDF → image ─────────────────────────────────────
//
// Accepts: file (PDF), body.format (jpg|png), body.pages ("all" | "1,3" | "2-5"),
// body.scale (0.5..4). Returns a single image when 1 page is selected,
// otherwise a zip archive.

router.post(
  "/pdf/to-jpg",
  ...processHandler("/tool/pdf-to-jpg", "single", async (req) => {
    const pages = typeof req.body.pages === "string" && req.body.pages.length <= 200 ? req.body.pages : "all";
    const scale = clampFloat(req.body.scale, 2, 0.5, 4);
    const quality = clampFloat(req.body.quality, 0.85, 0.3, 1);
    const { outputPath, pageCount } = await pdfRenderService.pdfToImages(req.file.path, {
      format: "jpg", pages, scale, jpegQuality: quality,
    });
    const base = origName(req, "document.pdf").replace(/\.pdf$/i, "");
    const filename = pageCount === 1 ? `${base}.jpg` : `${base}_jpg.zip`;
    return { outputPath, filename };
  })
);

router.post(
  "/pdf/to-png",
  ...processHandler("/tool/pdf-to-png", "single", async (req) => {
    const pages = typeof req.body.pages === "string" && req.body.pages.length <= 200 ? req.body.pages : "all";
    const scale = clampFloat(req.body.scale, 2, 0.5, 4);
    const { outputPath, pageCount } = await pdfRenderService.pdfToImages(req.file.path, {
      format: "png", pages, scale,
    });
    const base = origName(req, "document.pdf").replace(/\.pdf$/i, "");
    const filename = pageCount === 1 ? `${base}.png` : `${base}_png.zip`;
    return { outputPath, filename };
  })
);

// ─── Video / Audio (ffmpeg, queued) ──────────────────

router.post(
  "/video/to-mp3",
  ...processHandler("/tool/video-to-mp3", "single", async (req) => {
    const bitrate = oneOf(req.body && req.body.bitrate, ["96k", "128k", "192k", "256k", "320k"], "128k");
    const result = await mediaService.extractAudio(req.file.path, { bitrate });
    const safeName = origName(req, "audio").replace(/\.[^.]+$/, ".mp3");
    return { outputPath: result, filename: safeName };
  })
);

router.post(
  "/video/to-gif",
  ...processHandler("/tool/mp4-to-gif", "single", async (req) => {
    const fps = clampInt(req.body && req.body.fps, 12, 2, 20);
    const width = clampInt(req.body && req.body.width, 480, 80, 800);
    const result = await mediaService.videoToGif(req.file.path, { fps, width });
    const safeName = origName(req, "clip").replace(/\.[^.]+$/, ".gif");
    return { outputPath: result, filename: safeName };
  })
);

// ─── Office (LibreOffice headless, queued) ───────────

router.post(
  "/ppt/to-pdf",
  ...processHandler("/tool/ppt-to-pdf", "single", async (req) => {
    if (!officeService.isAvailable()) {
      const err = new Error("PPT→PDF requires LibreOffice on the server (not installed)");
      err.status = 503;
      throw err;
    }
    const result = await officeService.officeToPdf(req.file.path);
    const safeName = origName(req, "deck").replace(/\.(pptx?|odp)$/i, ".pdf");
    return { outputPath: result, filename: safeName };
  })
);

// ─── DOCX ────────────────────────────────────────────

router.post(
  "/docx/to-txt",
  ...processHandler("/tool/docx-to-txt", "single", async (req) => {
    const result = await docxService.docxToTxt(req.file.path);
    return {
      outputPath: result,
      filename: origName(req, "document.docx").replace(/\.docx?$/i, ".txt"),
    };
  })
);

router.post(
  "/docx/to-pdf",
  ...processHandler("/tool/word-to-pdf", "single", async (req) => {
    const result = await docxService.docxToPdf(req.file.path);
    return {
      outputPath: result,
      filename: origName(req, "document.docx").replace(/\.docx?$/i, ".pdf"),
    };
  })
);

// ─── XLSX ────────────────────────────────────────────

router.post(
  "/xlsx/to-pdf",
  ...processHandler("/tool/excel-to-pdf", "single", async (req) => {
    const result = await xlsxService.xlsxToPdf(req.file.path);
    return {
      outputPath: result,
      filename: origName(req, "spreadsheet.xlsx").replace(/\.xlsx?$/i, ".pdf"),
    };
  })
);

module.exports = router;
