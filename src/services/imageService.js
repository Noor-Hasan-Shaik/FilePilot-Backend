const sharp = require("sharp");
const fs = require("fs");
const { PDFDocument } = require("pdf-lib");
const { outputPathFor } = require("../utils/outputPath");

exports.compressImage = async (inputPath, quality = 70) => {
  const outputPath = outputPathFor(inputPath, "compressed", ".jpg");
  await sharp(inputPath).jpeg({ quality }).toFile(outputPath);
  return outputPath;
};

exports.resizeImage = async (inputPath, width = 800, height = 600) => {
  const outputPath = outputPathFor(inputPath, "resized", ".jpg");
  await sharp(inputPath).resize(width, height, { fit: "inside" }).toFile(outputPath);
  return outputPath;
};

exports.convertToFormat = async (inputPath, format) => {
  const ext = format === "jpeg" ? "jpg" : format;
  const outputPath = outputPathFor(inputPath, "converted", `.${ext}`);
  const img = sharp(inputPath);
  if (format === "png") await img.png().toFile(outputPath);
  else if (format === "jpg" || format === "jpeg") await img.jpeg({ quality: 90 }).toFile(outputPath);
  else if (format === "webp") await img.webp({ quality: 85 }).toFile(outputPath);
  else throw new Error(`Unsupported format: ${format}`);
  return outputPath;
};

exports.rotateImage = async (inputPath, degrees = 90) => {
  const outputPath = outputPathFor(inputPath, "rotated", ".jpg");
  await sharp(inputPath).rotate(degrees).jpeg({ quality: 92 }).toFile(outputPath);
  return outputPath;
};

exports.grayscaleImage = async (inputPath) => {
  const outputPath = outputPathFor(inputPath, "bw", ".jpg");
  await sharp(inputPath).grayscale().jpeg({ quality: 90 }).toFile(outputPath);
  return outputPath;
};

exports.flipImage = async (inputPath, direction = "horizontal") => {
  const outputPath = outputPathFor(inputPath, "flipped", ".jpg");
  const img = sharp(inputPath);
  if (direction === "horizontal") await img.flop().jpeg({ quality: 92 }).toFile(outputPath);
  else await img.flip().jpeg({ quality: 92 }).toFile(outputPath);
  return outputPath;
};

exports.blurImage = async (inputPath, sigma = 5) => {
  const outputPath = outputPathFor(inputPath, "blurred", ".jpg");
  await sharp(inputPath).blur(sigma).jpeg({ quality: 90 }).toFile(outputPath);
  return outputPath;
};

/**
 * Apply a pipeline of perceptual filters in a single sharp pass.
 * Inputs are taken in "human" units (percent for brightness/saturation/contrast,
 * sigma px for sharpness) and mapped to sharp's parameter space.
 *
 *   brightnessPct  50..200  (100 = identity)
 *   contrastPct    50..200  (100 = identity)
 *   saturationPct  0..300   (100 = identity)
 *   sharpnessSigma 0..5     (0 = off)
 */
exports.enhanceImage = async (
  inputPath,
  { brightnessPct = 100, contrastPct = 100, saturationPct = 100, sharpnessSigma = 0 } = {}
) => {
  const brightness = Math.max(0.2, Math.min(3, brightnessPct / 100));
  const saturation = Math.max(0, Math.min(4, saturationPct / 100));
  // Contrast as linear() a*x + b: map 100% → identity, 200% → 2× spread around 0.5.
  const contrast = Math.max(0.2, Math.min(3, contrastPct / 100));
  const a = contrast;
  const b = (1 - contrast) * 128;

  let pipeline = sharp(inputPath).modulate({ brightness, saturation }).linear(a, b);
  if (sharpnessSigma > 0) {
    pipeline = pipeline.sharpen({ sigma: Math.min(5, Math.max(0.3, sharpnessSigma)) });
  }

  const outputPath = outputPathFor(inputPath, "enhanced", ".jpg");
  await pipeline.jpeg({ quality: 92 }).toFile(outputPath);
  return outputPath;
};

exports.cropToSquare = async (inputPath) => {
  const meta = await sharp(inputPath).metadata();
  const side = Math.min(meta.width, meta.height);
  const left = Math.floor((meta.width - side) / 2);
  const top = Math.floor((meta.height - side) / 2);
  const outputPath = outputPathFor(inputPath, "square", ".jpg");
  await sharp(inputPath)
    .extract({ left, top, width: side, height: side })
    .jpeg({ quality: 90 })
    .toFile(outputPath);
  return outputPath;
};

exports.getImageInfo = async (inputPath) => {
  const metadata = await sharp(inputPath).metadata();
  const stats = fs.statSync(inputPath);
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    size: stats.size,
    channels: metadata.channels,
    hasAlpha: metadata.hasAlpha,
  };
};

// Merge images side-by-side (horizontal) or stacked (vertical)
exports.mergeImages = async (inputPaths, direction = "horizontal") => {
  const images = [];
  for (const p of inputPaths) {
    const meta = await sharp(p).metadata();
    images.push({ path: p, width: meta.width, height: meta.height });
  }

  let canvasW, canvasH;
  if (direction === "horizontal") {
    canvasH = Math.max(...images.map((i) => i.height));
    canvasW = images.reduce((sum, i) => sum + i.width, 0);
  } else {
    canvasW = Math.max(...images.map((i) => i.width));
    canvasH = images.reduce((sum, i) => sum + i.height, 0);
  }

  const composites = [];
  let offset = 0;
  for (const img of images) {
    const buf = await sharp(img.path).toBuffer();
    if (direction === "horizontal") {
      composites.push({ input: buf, left: offset, top: 0 });
      offset += img.width;
    } else {
      composites.push({ input: buf, left: 0, top: offset });
      offset += img.height;
    }
  }

  const outputPath = outputPathFor(inputPaths[0], "merged", ".jpg");
  await sharp({ create: { width: canvasW, height: canvasH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toFile(outputPath);

  return outputPath;
};

// Color-key background remover. This is *not* portrait-quality matting — that
// needs an ML model (U²-Net or similar) which we deliberately don't ship to
// keep the request cheap and the deploy dependency-free. Honest scope:
//   - Solid / near-solid backgrounds (studio, product photos, chroma-key) work
//     well.
//   - Complex real-world scenes (hair against trees, gradients) won't.
// Callers can pass `{ color: "#aabbcc", tolerance, feather }` to override the
// auto-sampled corner-average, which is what makes the tool usable on
// non-corner-uniform backgrounds.
function parseHexColor(input) {
  if (typeof input !== "string") return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

exports.removeBackground = async (inputPath, opts = {}) => {
  const outputPath = outputPathFor(inputPath, "nobg", ".png");
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  const tolerance = Math.max(0, Math.min(200, Number(opts.tolerance) || 60));
  const feather = Math.max(0, Math.min(120, Number(opts.feather) || 30));

  let bg = parseHexColor(opts.color);
  if (!bg) {
    // Auto-sample the four corners and use the median per-channel to resist a
    // single off-color corner (e.g. a logo) skewing the average.
    const corners = [];
    const sample = (x, y) => {
      const idx = (y * width + x) * channels;
      corners.push([data[idx], data[idx + 1], data[idx + 2]]);
    };
    sample(0, 0);
    sample(width - 1, 0);
    sample(0, height - 1);
    sample(width - 1, height - 1);
    const median = (k) => {
      const xs = corners.map((c) => c[k]).sort((a, b) => a - b);
      return Math.round((xs[1] + xs[2]) / 2);
    };
    bg = [median(0), median(1), median(2)];
  }

  const [bgR, bgG, bgB] = bg;
  const result = Buffer.from(data);

  for (let i = 0; i < result.length; i += channels) {
    const dr = result[i] - bgR;
    const dg = result[i + 1] - bgG;
    const db = result[i + 2] - bgB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    if (dist < tolerance) {
      result[i + 3] = 0;
    } else if (dist < tolerance + feather) {
      const alpha = Math.round(((dist - tolerance) / feather) * 255);
      result[i + 3] = Math.min(result[i + 3], alpha);
    }
  }

  await sharp(result, { raw: { width, height, channels } })
    .png()
    .toFile(outputPath);

  return outputPath;
};

// Convert multiple images into a single PDF
exports.imagesToPdf = async (inputPaths) => {
  const pdfDoc = await PDFDocument.create();

  for (const imgPath of inputPaths) {
    const buf = await sharp(imgPath).jpeg({ quality: 90 }).toBuffer();
    const meta = await sharp(imgPath).metadata();
    const img = await pdfDoc.embedJpg(buf);
    const page = pdfDoc.addPage([meta.width, meta.height]);
    page.drawImage(img, { x: 0, y: 0, width: meta.width, height: meta.height });
  }

  const pdfBytes = await pdfDoc.save();
  const outputPath = outputPathFor(inputPaths[0], "images", ".pdf");
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
};
