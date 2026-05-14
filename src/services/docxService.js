const fs = require("fs");
const path = require("path");
const mammoth = require("mammoth");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { outputPathFor } = require("../utils/outputPath");

/**
 * Convert a .docx file to plain text using mammoth's rawText extractor.
 * Returns the path to the .txt output.
 */
exports.docxToTxt = async (inputPath) => {
  const result = await mammoth.extractRawText({ path: inputPath });
  const outputPath = outputPathFor(inputPath, "text", ".txt");
  fs.writeFileSync(outputPath, result.value || "", "utf8");
  return outputPath;
};

/**
 * Convert a .docx file to PDF.
 * mammoth flattens the document to plain text (preserving paragraph breaks),
 * then pdf-lib lays it out with word wrap and pagination. This handles the
 * common case (essays, letters, notes) — complex tables/images are not preserved.
 */
exports.docxToPdf = async (inputPath) => {
  const { value: rawText } = await mammoth.extractRawText({ path: inputPath });
  const text = (rawText || "").replace(/\r\n/g, "\n");

  const pdf = await PDFDocument.create();
  pdf.setTitle(path.basename(inputPath, path.extname(inputPath)));
  pdf.setCreator("FilePilot");

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const margin = 56; // ~0.78"
  const pageWidth = 595;
  const pageHeight = 842;
  const lineHeight = fontSize * 1.4;
  const maxLineWidth = pageWidth - margin * 2;

  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = "";
    for (const word of words) {
      const test = current ? current + " " + word : word;
      if (font.widthOfTextAtSize(test, fontSize) > maxLineWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
  }

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  for (const line of lines) {
    if (y < margin + lineHeight) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
    if (line) {
      page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
    }
    y -= lineHeight;
  }

  const bytes = await pdf.save({ useObjectStreams: true });
  const outputPath = outputPathFor(inputPath, "docx", ".pdf");
  fs.writeFileSync(outputPath, bytes);
  return outputPath;
};
