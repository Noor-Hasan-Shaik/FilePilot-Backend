const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { outputPathFor } = require("../utils/outputPath");

function cellToString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value.richText) return value.richText.map((r) => r.text).join("");
    if (value.text) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Convert an .xlsx file to PDF by rendering each non-empty sheet as a simple table.
 * Width is fixed (landscape A4); columns auto-size proportionally to content within
 * a clamped min/max. Long cell text is truncated with an ellipsis to keep rows
 * single-line so the basic implementation stays fast and predictable.
 */
exports.xlsxToPdf = async (inputPath) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inputPath);

  const pdf = await PDFDocument.create();
  pdf.setTitle(path.basename(inputPath, path.extname(inputPath)));
  pdf.setCreator("FilePilot");

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontSize = 9;
  const padding = 4;
  const rowHeight = fontSize * 1.6;
  const pageWidth = 842;
  const pageHeight = 595;
  const margin = 36;
  const contentWidth = pageWidth - margin * 2;
  const headerColor = rgb(0.92, 0.94, 0.98);
  const altRowColor = rgb(0.97, 0.97, 0.99);
  const gridColor = rgb(0.8, 0.8, 0.85);
  const textColor = rgb(0.1, 0.1, 0.15);
  const maxColPx = 200;
  const minColPx = 40;

  const truncate = (text, maxWidth, f) => {
    if (f.widthOfTextAtSize(text, fontSize) <= maxWidth) return text;
    let s = text;
    while (s.length > 1 && f.widthOfTextAtSize(s + "…", fontSize) > maxWidth) {
      s = s.slice(0, -1);
    }
    return s + "…";
  };

  wb.worksheets.forEach((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells[(cell.col || 1) - 1] = cellToString(cell.value);
      });
      rows.push(cells);
    });
    if (rows.length === 0) return;

    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);

    // Approximate column widths based on content (capped).
    const colWidths = [];
    for (let c = 0; c < colCount; c++) {
      let w = minColPx;
      for (let r = 0; r < rows.length; r++) {
        const v = rows[r][c] || "";
        const measure = font.widthOfTextAtSize(v.slice(0, 80), fontSize) + padding * 2;
        if (measure > w) w = measure;
      }
      colWidths.push(Math.min(maxColPx, Math.max(minColPx, w)));
    }
    const totalWidth = colWidths.reduce((a, b) => a + b, 0);
    if (totalWidth > contentWidth) {
      const scale = contentWidth / totalWidth;
      for (let c = 0; c < colWidths.length; c++) {
        colWidths[c] = Math.max(minColPx * 0.5, colWidths[c] * scale);
      }
    }

    let page = pdf.addPage([pageWidth, pageHeight]);
    page.drawText(sheet.name || "Sheet", {
      x: margin, y: pageHeight - margin + 8, size: fontSize + 2, font: bold, color: textColor,
    });
    let y = pageHeight - margin - rowHeight;

    const drawRow = (cells, isHeader, rowIndex) => {
      if (!isHeader && rowIndex % 2 === 1) {
        page.drawRectangle({ x: margin, y, width: colWidths.reduce((a, b) => a + b, 0), height: rowHeight, color: altRowColor });
      }
      if (isHeader) {
        page.drawRectangle({ x: margin, y, width: colWidths.reduce((a, b) => a + b, 0), height: rowHeight, color: headerColor });
      }
      let x = margin;
      for (let c = 0; c < colCount; c++) {
        const w = colWidths[c];
        const txt = truncate(String(cells[c] || ""), w - padding * 2, font);
        page.drawText(txt, {
          x: x + padding,
          y: y + padding,
          size: fontSize,
          font: isHeader ? bold : font,
          color: textColor,
        });
        // Grid line right edge
        page.drawLine({
          start: { x: x + w, y },
          end: { x: x + w, y: y + rowHeight },
          thickness: 0.4,
          color: gridColor,
        });
        x += w;
      }
      // Bottom border
      page.drawLine({
        start: { x: margin, y },
        end: { x: margin + colWidths.reduce((a, b) => a + b, 0), y },
        thickness: 0.4,
        color: gridColor,
      });
    };

    const headerRow = rows[0];
    drawRow(headerRow, true, 0);
    y -= rowHeight;

    for (let i = 1; i < rows.length; i++) {
      if (y < margin) {
        page = pdf.addPage([pageWidth, pageHeight]);
        page.drawText(`${sheet.name || "Sheet"} (cont.)`, {
          x: margin, y: pageHeight - margin + 8, size: fontSize + 2, font: bold, color: textColor,
        });
        y = pageHeight - margin - rowHeight;
        drawRow(headerRow, true, 0);
        y -= rowHeight;
      }
      drawRow(rows[i], false, i);
      y -= rowHeight;
    }
  });

  const bytes = await pdf.save({ useObjectStreams: true });
  const outputPath = outputPathFor(inputPath, "xlsx", ".pdf");
  fs.writeFileSync(outputPath, bytes);
  return outputPath;
};
