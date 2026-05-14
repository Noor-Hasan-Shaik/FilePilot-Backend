const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const { validateFileContent } = require("../utils/validateFile");

function tryUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

const UPLOADS_DIR = path.join(__dirname, "../../uploads");
const OUTPUTS_DIR = path.join(__dirname, "../../outputs");

[UPLOADS_DIR, OUTPUTS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(8).toString("hex");
    const ext = path.extname(file.originalname || "").toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 8);
    cb(null, `${Date.now()}_${unique}${ext}`);
  },
});

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "video/mp4",
  "audio/mpeg",
]);

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    return cb(null, false);
  }
  cb(null, true);
};

const MAX_FILE_SIZE = 100 * 1024 * 1024;

const uploadSingleRaw = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
}).single("file");

const uploadMultipleRaw = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: 20 },
}).array("files", 20);

function validateAndCleanup(files, res) {
  for (const f of files) {
    if (!validateFileContent(f.path, f.mimetype)) {
      files.forEach((x) => tryUnlink(x.path));
      res.status(400).json({ error: `File content does not match declared type (${f.originalname || "file"})` });
      return false;
    }
  }
  return true;
}

function uploadSingle(req, res, next) {
  uploadSingleRaw(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return next();
    if (!validateAndCleanup([req.file], res)) return;
    next();
  });
}

function uploadMultiple(req, res, next) {
  uploadMultipleRaw(req, res, (err) => {
    if (err) return next(err);
    if (!req.files || req.files.length === 0) return next();
    if (!validateAndCleanup(req.files, res)) return;
    next();
  });
}

module.exports = { uploadSingle, uploadMultiple, UPLOADS_DIR, OUTPUTS_DIR, MAX_FILE_SIZE };
