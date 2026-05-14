const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const imageService = require("../services/imageService");
const pdfService = require("../services/pdfService");

const token = process.env.TELEGRAM_BOT_TOKEN;

// Real Telegram tokens look like "<bot_id>:<random>" — placeholders or empty
// strings should disable the bot rather than spam 404s every poll.
const looksLikeRealToken = typeof token === "string" && /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token);

if (!token || !looksLikeRealToken) {
  if (token && !looksLikeRealToken) {
    console.warn("TELEGRAM_BOT_TOKEN looks like a placeholder — Telegram bot disabled");
  } else {
    console.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
  }
  module.exports = { bot: null, stop: async () => {} };
} else {

const bot = new TelegramBot(token, {
  polling: { autoStart: true, params: { timeout: 10 } },
});

let pollingDisabled = false;
bot.on("polling_error", (err) => {
  if (pollingDisabled) return;
  const msg = err && err.message ? err.message : "";

  if (err.code === "ETELEGRAM" && msg.includes("409 Conflict")) {
    pollingDisabled = true;
    console.warn("Telegram bot: another instance running — stopping polling.");
    bot.stopPolling().catch(() => {});
    return;
  }

  // 401 Unauthorized = bad token; 404 Not Found = bad bot id. Either way, polling will
  // never succeed, so stop instead of flooding the log.
  if (err.code === "ETELEGRAM" && (msg.includes("401") || msg.includes("404"))) {
    pollingDisabled = true;
    console.error("Telegram bot: invalid TELEGRAM_BOT_TOKEN — stopping polling.");
    bot.stopPolling().catch(() => {});
    return;
  }

  console.error("Telegram polling error:", err.code || "", msg);
});

bot.on("error", (err) => {
  console.error("Telegram bot error:", err && err.message ? err.message : err);
});

bot.on("webhook_error", (err) => {
  console.error("Telegram webhook error:", err && err.message ? err.message : err);
});

console.log("Telegram bot started");

const TEMP = path.join(__dirname, "../../temp");

// ── State per chat ──────────────────────────────────────────────────
const pending   = new Map(); // chatId → { fileId, fileName, ext }
const queues    = new Map(); // chatId → { type, files:[{fileId,fileName}] }
const waiting   = new Map(); // chatId → { action, ...extra }

// ── Helpers ─────────────────────────────────────────────────────────
function tmp() { if (!fs.existsSync(TEMP)) fs.mkdirSync(TEMP, { recursive: true }); }

function fmt(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(2) + " MB";
}

function pct(before, after) { return Math.max(0, ((before - after) / before) * 100).toFixed(1); }

async function dl(fileId, name) {
  tmp();
  const p = path.join(TEMP, `${Date.now()}_${name}`);
  const link = await bot.getFileLink(fileId);
  const r = await axios({ url: link, method: "GET", responseType: "stream" });
  await new Promise((ok, fail) => r.data.pipe(fs.createWriteStream(p)).on("finish", ok).on("error", fail));
  return p;
}

function rm(...ps) { setTimeout(() => { for (const p of ps) { try { if (p) fs.unlinkSync(p); } catch {} } }, 15000); }

function ex(name) { return (name || "").split(".").pop().toLowerCase(); }

function msg(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", disable_web_page_preview: true, ...opts });
}

function edt(chatId, msgId, text, opts = {}) {
  return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", ...opts }).catch(() => {});
}

const IMG_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"];

// ── Keyboards ───────────────────────────────────────────────────────

const mainMenu = () => ({ reply_markup: { inline_keyboard: [
  [{ text: "📄 PDF Tools", callback_data: "cat_pdf" }, { text: "🖼 Image Tools", callback_data: "cat_img" }],
  [{ text: "🔄 Converters", callback_data: "cat_conv" }, { text: "🛠 Utilities", callback_data: "cat_util" }],
]}});

const backTo = (cat) => [{ text: "◀ Back", callback_data: cat }];

const pdfCat = () => ({ reply_markup: { inline_keyboard: [
  [{ text: "📦 Compress PDF", callback_data: "t_pdf_compress" }],
  [{ text: "✂️ Extract Page", callback_data: "t_pdf_split" }, { text: "📑 Extract Range", callback_data: "t_pdf_range" }],
  [{ text: "🔀 Merge PDFs", callback_data: "t_pdf_merge" }],
  [{ text: "🔄 Rotate Pages", callback_data: "t_pdf_rotate" }, { text: "🗑 Remove Page", callback_data: "t_pdf_remove" }],
  [{ text: "💧 Add Watermark", callback_data: "t_pdf_watermark" }],
  [{ text: "📊 PDF Info", callback_data: "t_pdf_info" }],
  backTo("menu_main"),
]}});

const imgCat = () => ({ reply_markup: { inline_keyboard: [
  [{ text: "📦 Compress", callback_data: "t_img_compress" }, { text: "📐 Resize", callback_data: "t_img_resize" }],
  [{ text: "→PNG", callback_data: "t_img_to_png" }, { text: "→JPG", callback_data: "t_img_to_jpg" }, { text: "→WebP", callback_data: "t_img_to_webp" }],
  [{ text: "🔄 Rotate", callback_data: "t_img_rotate" }, { text: "⬛ Square Crop", callback_data: "t_img_square" }],
  [{ text: "🎨 B&W", callback_data: "t_img_bw" }, { text: "🌀 Blur", callback_data: "t_img_blur" }, { text: "↔ Flip", callback_data: "t_img_flip" }],
  [{ text: "🖼 Merge Images", callback_data: "t_img_merge" }, { text: "🖼→PDF", callback_data: "t_img_to_pdf" }],
  [{ text: "📊 Image Info", callback_data: "t_img_info" }],
  backTo("menu_main"),
]}});

const convCat = () => ({ reply_markup: { inline_keyboard: [
  [{ text: "🖼 → PNG / JPG / WebP", callback_data: "cat_img" }],
  [{ text: "🖼 Images → PDF", callback_data: "t_img_to_pdf" }],
  [{ text: "📝 Text → PDF", callback_data: "t_txt_to_pdf" }],
  [{ text: "📄 PDF → Extract Pages", callback_data: "t_pdf_split" }],
  backTo("menu_main"),
]}});

const utilCat = () => ({ reply_markup: { inline_keyboard: [
  [{ text: "🔐 Password Gen", callback_data: "u_password" }, { text: "🎲 UUID", callback_data: "u_uuid" }],
  [{ text: "📱 QR Code Gen", callback_data: "u_qr" }],
  [{ text: "🔤 Text Case", callback_data: "u_textcase" }, { text: "📊 Word Count", callback_data: "u_wordcount" }],
  [{ text: "{ } JSON Format", callback_data: "u_json" }, { text: "🔣 Base64", callback_data: "u_base64" }],
  [{ text: "#️⃣ Hash Gen", callback_data: "u_hash" }, { text: "📝 Lorem Ipsum", callback_data: "u_lorem" }],
  backTo("menu_main"),
]}});

// File-specific keyboards (shown when a file is received)
function pdfFileKb() { return { reply_markup: { inline_keyboard: [
  [{ text: "📦 Compress", callback_data: "do_pdf_compress" }, { text: "📊 Info", callback_data: "do_pdf_info" }],
  [{ text: "✂️ Page 1", callback_data: "do_pdf_split" }, { text: "🔄 Rotate", callback_data: "do_pdf_rotate" }],
  [{ text: "🗑 Remove Page 1", callback_data: "do_pdf_removefirst" }],
  [{ text: "💧 Watermark", callback_data: "do_pdf_watermark" }],
  [{ text: "🔀 Add to Merge Queue", callback_data: "do_q_pdf_merge" }],
  [{ text: "✂️ Custom page / range...", callback_data: "do_pdf_ask_page" }],
  [{ text: "❌ Cancel", callback_data: "cancel" }],
]}}; }

function imgFileKb(e) {
  const conv = [];
  if (e !== "png") conv.push({ text: "→PNG", callback_data: "do_img_to_png" });
  if (e !== "jpg" && e !== "jpeg") conv.push({ text: "→JPG", callback_data: "do_img_to_jpg" });
  if (e !== "webp") conv.push({ text: "→WebP", callback_data: "do_img_to_webp" });
  return { reply_markup: { inline_keyboard: [
    [{ text: "📦 Compress", callback_data: "do_img_compress" }, { text: "📐 Resize", callback_data: "do_img_resize" }],
    conv,
    [{ text: "🔄 Rotate", callback_data: "do_img_rotate" }, { text: "⬛ Square", callback_data: "do_img_square" }, { text: "🎨 B&W", callback_data: "do_img_bw" }],
    [{ text: "🌀 Blur", callback_data: "do_img_blur" }, { text: "↔ Flip", callback_data: "do_img_flip" }, { text: "📊 Info", callback_data: "do_img_info" }],
    [{ text: "🔀 Add to Merge Queue", callback_data: "do_q_img_merge" }],
    [{ text: "🔀 Add to Images→PDF", callback_data: "do_q_img_pdf" }],
    [{ text: "❌ Cancel", callback_data: "cancel" }],
  ]}};
}

function queueKb(type, count) {
  const label = type === "pdf_merge" ? "Merge" : type === "img_merge" ? "Merge Images" : "Create PDF";
  return { reply_markup: { inline_keyboard: [
    [{ text: `✅ ${label} Now (${count} files)`, callback_data: `do_q_exec_${type}` }],
    [{ text: "❌ Cancel Queue", callback_data: "cancel" }],
  ]}};
}

const doneKb = () => ({ reply_markup: { inline_keyboard: [
  [{ text: "📋 Main Menu", callback_data: "menu_main" }],
]}});

// ── Commands ────────────────────────────────────────────────────────

bot.onText(/\/start/, (m) => {
  msg(m.chat.id,
    `*Welcome to FilePilot Bot* ✨\n\n` +
    `*40+ file tools* right inside Telegram!\n\n` +
    `📄 *PDF* — Compress, Split, Merge, Rotate, Watermark & more\n` +
    `🖼 *Image* — Compress, Resize, Convert, B&W, Blur, Merge & more\n` +
    `🔄 *Convert* — Images→PDF, Text→PDF, Format conversions\n` +
    `🛠 *Utility* — Password, QR Code, Hash, JSON, Base64 & more\n\n` +
    `👉 *Send a file* to process it, or tap *Menu* below:`,
    mainMenu()
  );
});

bot.onText(/\/(help|menu|tools)/, (m) => {
  msg(m.chat.id, `*FilePilot Tools* 🛠\n\nChoose a category:`, mainMenu());
});

bot.onText(/\/cancel/, (m) => {
  const c = m.chat.id;
  pending.delete(c); queues.delete(c); waiting.delete(c);
  msg(c, "Cancelled. Send a file or /menu to start.");
});

bot.onText(/\/password(?:\s+(\d+))?/, (m, match) => {
  const len = Math.min(Math.max(parseInt(match?.[1]) || 16, 8), 64);
  const ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*";
  let pw = ""; const b = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) pw += ch[b[i] % ch.length];
  msg(m.chat.id, `🔐 *Password* (${len} chars)\n\n\`${pw}\`\n\n_/password 24 for custom length_`, doneKb());
});

bot.onText(/\/uuid/, (m) => {
  msg(m.chat.id, `🎲 *UUID*\n\n\`${crypto.randomUUID()}\``, doneKb());
});

// ── File Received ───────────────────────────────────────────────────

bot.on("document", async (m) => {
  const c = m.chat.id;
  const name = m.document.file_name || "file";
  const e = ex(name);
  const size = m.document.file_size || 0;

  // If a queue is active, add to it
  const q = queues.get(c);
  if (q) {
    const validForQueue =
      (q.type === "pdf_merge" && e === "pdf") ||
      (q.type === "img_merge" && IMG_EXT.includes(e)) ||
      (q.type === "img_pdf" && IMG_EXT.includes(e));

    if (validForQueue) {
      q.files.push({ fileId: m.document.file_id, fileName: name });
      const n = q.files.length;
      const names = q.files.map((f, i) => `  ${i + 1}. \`${f.fileName}\``).join("\n");
      msg(c, `✅ Added *${name}*\n\n*Queue (${n} files):*\n${names}\n\nSend more or tap the button:`, queueKb(q.type, n));
      return;
    }
  }

  if (e === "pdf") {
    pending.set(c, { fileId: m.document.file_id, fileName: name, ext: e });
    msg(c, `📄 *PDF Received*\n\n📎 \`${name}\`  •  ${fmt(size)}\n\nPick an action:`, pdfFileKb());
  } else if (IMG_EXT.includes(e)) {
    pending.set(c, { fileId: m.document.file_id, fileName: name, ext: e });
    msg(c, `🖼 *Image Received*\n\n📎 \`${name}\`  •  ${fmt(size)}\n\nPick an action:`, imgFileKb(e));
  } else {
    msg(c, `⚠️ *${e.toUpperCase()}* files aren't supported yet.\n\nI work with: *PDF, JPG, PNG, WebP, GIF, BMP, TIFF*\n\nOr try /menu for text-based utilities.`);
  }
});

bot.on("photo", async (m) => {
  const c = m.chat.id;
  const photo = m.photo[m.photo.length - 1];
  const name = `photo_${Date.now()}.jpg`;

  const q = queues.get(c);
  if (q && (q.type === "img_merge" || q.type === "img_pdf")) {
    q.files.push({ fileId: photo.file_id, fileName: name });
    const n = q.files.length;
    msg(c, `✅ Photo added (#${n})\n\nSend more or tap the button:`, queueKb(q.type, n));
    return;
  }

  pending.set(c, { fileId: photo.file_id, fileName: name, ext: "jpg" });
  msg(c, `🖼 *Photo Received*\n\nPick an action:`, imgFileKb("jpg"));
});

// ── Text messages (for tools that need text input) ──────────────────

bot.on("message", (m) => {
  if (!m.text || m.text.startsWith("/") || m.document || m.photo) return;
  const c = m.chat.id;
  const w = waiting.get(c);

  if (!w) {
    msg(c, `Send me a *file or photo* to process, or tap /menu for all tools.`, mainMenu());
    return;
  }

  waiting.delete(c);
  const text = m.text;

  // ── Text-input handlers ───
  if (w.action === "watermark") {
    processWithText(c, w, "watermark", text);
  } else if (w.action === "txt_to_pdf") {
    textToPdf(c, text);
  } else if (w.action === "pdf_page") {
    handlePageInput(c, w, text);
  } else if (w.action === "qr") {
    generateQr(c, text);
  } else if (w.action === "textcase") {
    textCase(c, text);
  } else if (w.action === "wordcount") {
    wordCount(c, text);
  } else if (w.action === "json") {
    jsonFormat(c, text);
  } else if (w.action === "base64") {
    base64Tool(c, text);
  } else if (w.action === "hash") {
    hashGen(c, text);
  }
});

// ── Utility tool implementations ────────────────────────────────────

async function textToPdf(c, text) {
  tmp();
  const out = path.join(TEMP, `${Date.now()}_text.pdf`);
  try {
    await pdfService.textToPdf(text, out);
    await bot.sendDocument(c, out, { caption: `✅ *Text converted to PDF*\n\n${text.split("\n").length} lines`, parse_mode: "Markdown" });
    msg(c, "Done! Send another file or /menu.", doneKb());
  } catch (err) {
    msg(c, `❌ Failed: ${err.message}`);
  }
  rm(out);
}

async function generateQr(c, text) {
  tmp();
  const out = path.join(TEMP, `${Date.now()}_qr.png`);
  try {
    await QRCode.toFile(out, text, { width: 512, margin: 2 });
    await bot.sendPhoto(c, out, { caption: `📱 *QR Code Generated*\n\nContent: \`${text.length > 100 ? text.slice(0, 100) + "..." : text}\``, parse_mode: "Markdown" });
    msg(c, "Done! Send text for another QR or /menu.", doneKb());
  } catch (err) {
    msg(c, `❌ Failed: ${err.message}`);
  }
  rm(out);
}

function textCase(c, text) {
  msg(c,
    `🔤 *Text Case Conversions*\n\n` +
    `*UPPER:*\n\`${text.toUpperCase()}\`\n\n` +
    `*lower:*\n\`${text.toLowerCase()}\`\n\n` +
    `*Title:*\n\`${text.replace(/\b\w/g, (l) => l.toUpperCase())}\`\n\n` +
    `*Sentence:*\n\`${text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()}\``,
    doneKb()
  );
}

function wordCount(c, text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  const charsNoSpace = text.replace(/\s/g, "").length;
  const lines = text.split("\n").length;
  const sentences = text.split(/[.!?]+/).filter(Boolean).length;
  msg(c,
    `📊 *Text Analysis*\n\n` +
    `Words: *${words}*\n` +
    `Characters: *${chars}*\n` +
    `Characters (no spaces): *${charsNoSpace}*\n` +
    `Lines: *${lines}*\n` +
    `Sentences: *~${sentences}*`,
    doneKb()
  );
}

function jsonFormat(c, text) {
  try {
    const parsed = JSON.parse(text);
    const formatted = JSON.stringify(parsed, null, 2);
    if (formatted.length > 4000) {
      msg(c, `✅ *Valid JSON* — too large to display, sending as file...`);
      tmp();
      const out = path.join(TEMP, `${Date.now()}_formatted.json`);
      fs.writeFileSync(out, formatted);
      bot.sendDocument(c, out, { caption: "Formatted JSON" }).then(() => rm(out));
    } else {
      msg(c, `✅ *Valid JSON*\n\n\`\`\`json\n${formatted}\n\`\`\``, doneKb());
    }
  } catch (err) {
    msg(c, `❌ *Invalid JSON*\n\n\`${err.message}\``, doneKb());
  }
}

function base64Tool(c, text) {
  // Try to decode first; if it looks like base64, decode. Otherwise encode.
  const b64Regex = /^[A-Za-z0-9+/]+=*$/;
  if (b64Regex.test(text.replace(/\s/g, "")) && text.length > 10) {
    try {
      const decoded = Buffer.from(text, "base64").toString("utf-8");
      msg(c, `🔣 *Base64 Decoded:*\n\n\`${decoded.length > 3000 ? decoded.slice(0, 3000) + "..." : decoded}\``, doneKb());
      return;
    } catch {}
  }
  const encoded = Buffer.from(text).toString("base64");
  msg(c, `🔣 *Base64 Encoded:*\n\n\`${encoded}\``, doneKb());
}

function hashGen(c, text) {
  const md5 = crypto.createHash("md5").update(text).digest("hex");
  const sha1 = crypto.createHash("sha1").update(text).digest("hex");
  const sha256 = crypto.createHash("sha256").update(text).digest("hex");
  const sha512 = crypto.createHash("sha512").update(text).digest("hex");
  msg(c,
    `#️⃣ *Hash Results*\n\n` +
    `*MD5:*\n\`${md5}\`\n\n` +
    `*SHA1:*\n\`${sha1}\`\n\n` +
    `*SHA256:*\n\`${sha256}\`\n\n` +
    `*SHA512:*\n\`${sha512}\``,
    doneKb()
  );
}

// ── Watermark with pending file ─────────────────────────────────────

async function processWithText(c, w, action, text) {
  if (!w.fileId) return msg(c, "No file found. Send a PDF first.");
  const statusMsg = await msg(c, "⏳ *Processing...*");
  let fp = null, out = null;
  try {
    fp = await dl(w.fileId, w.fileName);
    if (action === "watermark") {
      out = await pdfService.addWatermark(fp, text);
      await bot.sendDocument(c, out, { caption: `✅ *Watermark Added*\n\nText: "${text}"`, parse_mode: "Markdown" });
    }
    bot.deleteMessage(c, statusMsg.message_id).catch(() => {});
    msg(c, "Done! Send another file or /menu.", doneKb());
  } catch (err) {
    edt(c, statusMsg.message_id, `❌ Failed: ${err.message}`);
  }
  rm(fp, out);
}

// ── Page input handler ──────────────────────────────────────────────

async function handlePageInput(c, w, text) {
  if (!w.fileId) return msg(c, "No file found. Send a PDF first.");
  const statusMsg = await msg(c, "⏳ *Processing...*");
  let fp = null, out = null;
  try {
    fp = await dl(w.fileId, w.fileName);

    if (text.includes("-")) {
      // Range: "2-5"
      const [s, e] = text.split("-").map((n) => parseInt(n.trim()) - 1);
      out = await pdfService.extractPageRange(fp, s, e);
      await bot.sendDocument(c, out, { caption: `✅ *Pages ${s + 1}–${e + 1} extracted*`, parse_mode: "Markdown" });
    } else if (text.includes(",")) {
      // Remove pages: "1,3,5"
      const pages = text.split(",").map((n) => parseInt(n.trim()) - 1);
      out = await pdfService.removePages(fp, pages);
      await bot.sendDocument(c, out, { caption: `✅ *${pages.length} page(s) removed*`, parse_mode: "Markdown" });
    } else {
      // Single page extract
      const page = parseInt(text.trim()) - 1;
      out = await pdfService.splitPdf(fp, page);
      await bot.sendDocument(c, out, { caption: `✅ *Page ${page + 1} extracted*`, parse_mode: "Markdown" });
    }
    bot.deleteMessage(c, statusMsg.message_id).catch(() => {});
    msg(c, "Done! Send another file or /menu.", doneKb());
  } catch (err) {
    edt(c, statusMsg.message_id, `❌ Failed: ${err.message}`);
  }
  rm(fp, out);
}

// ── Callback handler (all button presses) ───────────────────────────

bot.on("callback_query", async (query) => {
  const c = query.message.chat.id;
  const mid = query.message.message_id;
  const d = query.data;
  bot.answerCallbackQuery(query.id);

  // ── Navigation ──
  if (d === "menu_main") return edt(c, mid, "*FilePilot Tools* 🛠\n\nChoose a category:", mainMenu());
  if (d === "cat_pdf")  return edt(c, mid, "*📄 PDF Tools*\n\nSend a PDF then pick an action, or start a tool:", pdfCat());
  if (d === "cat_img")  return edt(c, mid, "*🖼 Image Tools*\n\nSend a photo/image then pick an action:", imgCat());
  if (d === "cat_conv") return edt(c, mid, "*🔄 Converters*\n\nConvert between file formats:", convCat());
  if (d === "cat_util") return edt(c, mid, "*🛠 Utilities*\n\nText-based tools — no file needed:", utilCat());

  // ── Cancel ──
  if (d === "cancel") {
    pending.delete(c); queues.delete(c); waiting.delete(c);
    return edt(c, mid, "Cancelled. Send a file or /menu to start.");
  }

  // ── Tool info (from category menus — prompts to send file) ──
  if (d.startsWith("t_")) {
    const tool = d.slice(2);
    const prompts = {
      pdf_compress:   ["📦 *Compress PDF*\n\nReduces PDF file size.\n\n👉 *Send me a PDF file to compress.*"],
      pdf_split:      ["✂️ *Extract Page*\n\nExtract a single page from a PDF.\n\n👉 *Send me a PDF file.*"],
      pdf_range:      ["📑 *Extract Range*\n\nExtract a range of pages (e.g. pages 2-5).\n\n👉 *Send me a PDF file.*"],
      pdf_merge:      ["🔀 *Merge PDFs*\n\nCombine multiple PDFs into one.\n\n👉 *Send me the first PDF file.*"],
      pdf_rotate:     ["🔄 *Rotate PDF*\n\nRotate all pages 90° clockwise.\n\n👉 *Send me a PDF file.*"],
      pdf_remove:     ["🗑 *Remove Pages*\n\nDelete specific pages from a PDF.\n\n👉 *Send me a PDF file.*"],
      pdf_watermark:  ["💧 *Add Watermark*\n\nAdd diagonal text watermark to all pages.\n\n👉 *Send me a PDF file.*"],
      pdf_info:       ["📊 *PDF Info*\n\nView page count, dimensions, file size.\n\n👉 *Send me a PDF file.*"],
      img_compress:   ["📦 *Compress Image*\n\nReduce image file size (70% JPEG).\n\n👉 *Send me an image.*"],
      img_resize:     ["📐 *Resize Image*\n\nFit within 800×600 keeping aspect ratio.\n\n👉 *Send me an image.*"],
      img_to_png:     ["🔄 *Convert → PNG*\n\nLossless format with transparency.\n\n👉 *Send me an image.*"],
      img_to_jpg:     ["🔄 *Convert → JPG*\n\nSmaller file, best for photos.\n\n👉 *Send me an image.*"],
      img_to_webp:    ["🔄 *Convert → WebP*\n\nModern format, great quality+size.\n\n👉 *Send me an image.*"],
      img_rotate:     ["🔄 *Rotate Image*\n\n90° clockwise rotation.\n\n👉 *Send me an image.*"],
      img_square:     ["⬛ *Square Crop*\n\nCenter-crop to perfect square.\n\n👉 *Send me an image.*"],
      img_bw:         ["🎨 *Black & White*\n\nConvert to grayscale.\n\n👉 *Send me an image.*"],
      img_blur:       ["🌀 *Blur Image*\n\nApply gaussian blur effect.\n\n👉 *Send me an image.*"],
      img_flip:       ["↔ *Flip Image*\n\nMirror horizontally.\n\n👉 *Send me an image.*"],
      img_merge:      ["🖼 *Merge Images*\n\nCombine multiple images side by side.\n\n👉 *Send me the first image.*"],
      img_to_pdf:     ["🖼→📄 *Images to PDF*\n\nConvert multiple images into one PDF.\n\n👉 *Send me the first image.*"],
      img_info:       ["📊 *Image Info*\n\nDimensions, format, file size.\n\n👉 *Send me an image.*"],
      txt_to_pdf:     ["📝 *Text to PDF*\n\nConvert text into a PDF document.\n\n👉 *Type or paste your text below:*"],
    };
    const [info] = prompts[tool] || ["Send a file to use this tool."];

    // For text-to-pdf, we wait for text input
    if (tool === "txt_to_pdf") {
      waiting.set(c, { action: "txt_to_pdf" });
      return edt(c, mid, info, { reply_markup: { inline_keyboard: [backTo("cat_conv")] } });
    }

    return edt(c, mid, info, { reply_markup: { inline_keyboard: [backTo(
      tool.startsWith("pdf") ? "cat_pdf" : tool.startsWith("img") ? "cat_img" : "menu_main"
    )] } });
  }

  // ── Utility tools (no file needed) ──
  if (d === "u_password") {
    const ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*";
    let pw = ""; const b = crypto.randomBytes(16);
    for (let i = 0; i < 16; i++) pw += ch[b[i] % ch.length];
    return edt(c, mid, `🔐 *Password*\n\n\`${pw}\`\n\n_/password 24 for custom length_`, {
      reply_markup: { inline_keyboard: [[{ text: "🔄 Another", callback_data: "u_password" }], backTo("cat_util")] },
    });
  }
  if (d === "u_uuid") {
    return edt(c, mid, `🎲 *UUID*\n\n\`${crypto.randomUUID()}\``, {
      reply_markup: { inline_keyboard: [[{ text: "🔄 Another", callback_data: "u_uuid" }], backTo("cat_util")] },
    });
  }
  if (d === "u_qr") {
    waiting.set(c, { action: "qr" });
    return edt(c, mid, "📱 *QR Code Generator*\n\n👉 *Send me the text or URL* you want to encode:", { reply_markup: { inline_keyboard: [backTo("cat_util")] } });
  }
  if (d === "u_textcase") {
    waiting.set(c, { action: "textcase" });
    return edt(c, mid, "🔤 *Text Case Converter*\n\n👉 *Send me the text* to convert:", { reply_markup: { inline_keyboard: [backTo("cat_util")] } });
  }
  if (d === "u_wordcount") {
    waiting.set(c, { action: "wordcount" });
    return edt(c, mid, "📊 *Word Counter*\n\n👉 *Send me the text* to analyze:", { reply_markup: { inline_keyboard: [backTo("cat_util")] } });
  }
  if (d === "u_json") {
    waiting.set(c, { action: "json" });
    return edt(c, mid, "{ } *JSON Formatter*\n\n👉 *Paste your JSON* to format & validate:", { reply_markup: { inline_keyboard: [backTo("cat_util")] } });
  }
  if (d === "u_base64") {
    waiting.set(c, { action: "base64" });
    return edt(c, mid, "🔣 *Base64 Tool*\n\nSend text → I'll encode it.\nSend base64 → I'll decode it.\n\n👉 *Send text below:*", { reply_markup: { inline_keyboard: [backTo("cat_util")] } });
  }
  if (d === "u_hash") {
    waiting.set(c, { action: "hash" });
    return edt(c, mid, "#️⃣ *Hash Generator*\n\nGenerates MD5, SHA1, SHA256, SHA512.\n\n👉 *Send the text* to hash:", { reply_markup: { inline_keyboard: [backTo("cat_util")] } });
  }
  if (d === "u_lorem") {
    const words = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur Excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum".split(" ");
    let lorem = "";
    for (let i = 0; i < 100; i++) lorem += words[Math.floor(Math.random() * words.length)] + " ";
    return edt(c, mid, `📝 *Lorem Ipsum*\n\n${lorem.trim()}`, {
      reply_markup: { inline_keyboard: [[{ text: "🔄 Regenerate", callback_data: "u_lorem" }], backTo("cat_util")] },
    });
  }

  // ── Queue operations ──
  if (d === "do_q_pdf_merge") {
    const p = pending.get(c);
    if (!p) return edt(c, mid, "No file found. Send a PDF first.");
    queues.set(c, { type: "pdf_merge", files: [{ fileId: p.fileId, fileName: p.fileName }] });
    pending.delete(c);
    return edt(c, mid, `🔀 *Merge Queue Started*\n\n  1. \`${p.fileName}\`\n\n👉 *Send more PDFs*, then tap Merge:`, queueKb("pdf_merge", 1));
  }
  if (d === "do_q_img_merge") {
    const p = pending.get(c);
    if (!p) return edt(c, mid, "No file. Send an image first.");
    queues.set(c, { type: "img_merge", files: [{ fileId: p.fileId, fileName: p.fileName }] });
    pending.delete(c);
    return edt(c, mid, `🖼 *Image Merge Queue*\n\n  1. \`${p.fileName}\`\n\n👉 *Send more images*, then tap Merge:`, queueKb("img_merge", 1));
  }
  if (d === "do_q_img_pdf") {
    const p = pending.get(c);
    if (!p) return edt(c, mid, "No file. Send an image first.");
    queues.set(c, { type: "img_pdf", files: [{ fileId: p.fileId, fileName: p.fileName }] });
    pending.delete(c);
    return edt(c, mid, `🖼→📄 *Images to PDF Queue*\n\n  1. \`${p.fileName}\`\n\n👉 *Send more images*, then tap Create PDF:`, queueKb("img_pdf", 1));
  }

  // ── Queue execute ──
  if (d.startsWith("do_q_exec_")) {
    const type = d.replace("do_q_exec_", "");
    const q = queues.get(c);
    if (!q || q.files.length < 2) return edt(c, mid, "Need at least 2 files. Send more!");
    edt(c, mid, `⏳ *Processing ${q.files.length} files...*`);
    const paths = [];
    try {
      for (const f of q.files) paths.push(await dl(f.fileId, f.fileName));
      let out;
      if (type === "pdf_merge") {
        out = await pdfService.mergePdfs(paths);
        await bot.sendDocument(c, out, { caption: `✅ *${q.files.length} PDFs Merged!*\n\nSize: ${fmt(fs.statSync(out).size)}`, parse_mode: "Markdown" });
        rm(out);
      } else if (type === "img_merge") {
        out = await imageService.mergeImages(paths, "horizontal");
        await bot.sendDocument(c, out, { caption: `✅ *${q.files.length} Images Merged!*`, parse_mode: "Markdown" });
        rm(out);
      } else if (type === "img_pdf") {
        out = await imageService.imagesToPdf(paths);
        await bot.sendDocument(c, out, { caption: `✅ *${q.files.length} Images → PDF!*\n\nSize: ${fmt(fs.statSync(out).size)}`, parse_mode: "Markdown" });
        rm(out);
      }
      bot.deleteMessage(c, mid).catch(() => {});
      msg(c, "Done! Send more files or /menu.", doneKb());
    } catch (err) {
      edt(c, mid, `❌ Failed: ${err.message}`);
    }
    rm(...paths);
    queues.delete(c);
    return;
  }

  // ── Watermark text prompt ──
  if (d === "do_pdf_watermark") {
    const p = pending.get(c);
    if (!p) return edt(c, mid, "No PDF found. Send a PDF first.");
    waiting.set(c, { action: "watermark", fileId: p.fileId, fileName: p.fileName });
    pending.delete(c);
    return edt(c, mid, "💧 *Add Watermark*\n\n👉 *Type the watermark text* you want on every page:", { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel" }]] } });
  }

  // ── Custom page/range prompt ──
  if (d === "do_pdf_ask_page") {
    const p = pending.get(c);
    if (!p) return edt(c, mid, "No PDF found. Send a PDF first.");
    waiting.set(c, { action: "pdf_page", fileId: p.fileId, fileName: p.fileName });
    pending.delete(c);
    return edt(c, mid,
      "✂️ *Custom Page Operation*\n\n" +
      "Type one of:\n" +
      "  `3` — extract page 3\n" +
      "  `2-5` — extract pages 2 to 5\n" +
      "  `1,3,5` — remove pages 1, 3 and 5\n\n" +
      "👉 *Enter page number(s):*",
      { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel" }]] } }
    );
  }

  // ── Direct file processing ──
  if (!d.startsWith("do_")) return;

  const p = pending.get(c);
  if (!p) return edt(c, mid, "No file found. Please send a file first!");

  edt(c, mid, "⏳ *Processing...*");

  let fp = null, out = null;
  try {
    fp = await dl(p.fileId, p.fileName);
    const origSize = fs.statSync(fp).size;
    let caption = "";

    switch (d) {
      // ── PDF actions ──
      case "do_pdf_compress": {
        out = await pdfService.compressPdf(fp);
        const ns = fs.statSync(out).size;
        caption = `✅ *PDF Compressed*\n\n📉 ${fmt(origSize)} → ${fmt(ns)}  (${pct(origSize, ns)}% saved)`;
        break;
      }
      case "do_pdf_info": {
        const info = await pdfService.getPdfInfo(fp);
        bot.deleteMessage(c, mid).catch(() => {});
        msg(c,
          `📊 *PDF Info*\n\n` +
          `📎 \`${p.fileName}\`\n` +
          `📄 Pages: *${info.pageCount}*\n` +
          `📐 Page size: ${info.pageWidth} × ${info.pageHeight} pts\n` +
          `💾 Size: *${fmt(info.size)}*`,
          doneKb()
        );
        rm(fp); pending.delete(c);
        return;
      }
      case "do_pdf_split": {
        out = await pdfService.splitPdf(fp, 0);
        caption = `✅ *Page 1 Extracted*`;
        break;
      }
      case "do_pdf_rotate": {
        out = await pdfService.rotatePdf(fp, 90);
        caption = `✅ *PDF Rotated 90°*`;
        break;
      }
      case "do_pdf_removefirst": {
        const info = await pdfService.getPdfInfo(fp);
        if (info.pageCount <= 1) throw new Error("Can't remove the only page");
        out = await pdfService.removePages(fp, [0]);
        caption = `✅ *Page 1 Removed*\n\n${info.pageCount} → ${info.pageCount - 1} pages`;
        break;
      }

      // ── Image actions ──
      case "do_img_compress": {
        out = await imageService.compressImage(fp);
        const ns = fs.statSync(out).size;
        caption = `✅ *Image Compressed*\n\n📉 ${fmt(origSize)} → ${fmt(ns)}  (${pct(origSize, ns)}% saved)`;
        break;
      }
      case "do_img_resize": {
        out = await imageService.resizeImage(fp);
        const info = await imageService.getImageInfo(out);
        caption = `✅ *Image Resized*\n\n📐 ${info.width} × ${info.height}  •  ${fmt(info.size)}`;
        break;
      }
      case "do_img_to_png": case "do_img_to_jpg": case "do_img_to_webp": {
        const format = d.split("_").pop();
        out = await imageService.convertToFormat(fp, format);
        caption = `✅ *Converted to ${format.toUpperCase()}*\n\n💾 ${fmt(fs.statSync(out).size)}`;
        break;
      }
      case "do_img_rotate": {
        out = await imageService.rotateImage(fp, 90);
        caption = `✅ *Rotated 90°*`;
        break;
      }
      case "do_img_square": {
        out = await imageService.cropToSquare(fp);
        const info = await imageService.getImageInfo(out);
        caption = `✅ *Cropped to Square*\n\n📐 ${info.width} × ${info.height}`;
        break;
      }
      case "do_img_bw": {
        out = await imageService.grayscaleImage(fp);
        caption = `✅ *Black & White*`;
        break;
      }
      case "do_img_blur": {
        out = await imageService.blurImage(fp, 8);
        caption = `✅ *Blur Applied*`;
        break;
      }
      case "do_img_flip": {
        out = await imageService.flipImage(fp, "horizontal");
        caption = `✅ *Flipped Horizontally*`;
        break;
      }
      case "do_img_info": {
        const info = await imageService.getImageInfo(fp);
        bot.deleteMessage(c, mid).catch(() => {});
        msg(c,
          `📊 *Image Info*\n\n` +
          `📎 \`${p.fileName}\`\n` +
          `📐 Size: *${info.width} × ${info.height}*\n` +
          `🎨 Format: *${(info.format || "?").toUpperCase()}*\n` +
          `💾 File: *${fmt(info.size)}*\n` +
          `🖼 Channels: ${info.channels}${info.hasAlpha ? " (alpha)" : ""}`,
          doneKb()
        );
        rm(fp); pending.delete(c);
        return;
      }
      default: throw new Error("Unknown action");
    }

    await bot.sendDocument(c, out, { caption, parse_mode: "Markdown" });
    bot.deleteMessage(c, mid).catch(() => {});
    msg(c, "Done! Send another file or /menu.", doneKb());

  } catch (err) {
    console.error("Bot processing error:", err.message);
    edt(c, mid, `❌ *Failed:* ${err.message}`, { reply_markup: { inline_keyboard: [[{ text: "📋 Menu", callback_data: "menu_main" }]] } });
  } finally {
    rm(fp, out);
    pending.delete(c);
  }
});

async function stop() {
  try {
    await bot.stopPolling({ cancel: true });
  } catch (e) {
    console.error("Error stopping telegram bot:", e.message);
  }
}

module.exports = { bot, stop };
} // end else (token exists)
