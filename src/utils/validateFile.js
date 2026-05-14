const fs = require("fs");

// Magic-byte signatures keyed by MIME. Values may be a single signature or an array.
const SIGNATURES = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]], // %PDF
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF (offset 0); WEBP at offset 8 not enforced
  "image/gif": [[0x47, 0x49, 0x46, 0x38]],
  "image/bmp": [[0x42, 0x4d]],
  "image/tiff": [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [[0x50, 0x4b, 0x03, 0x04]],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [[0x50, 0x4b, 0x03, 0x04]],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [[0x50, 0x4b, 0x03, 0x04]],
  "video/mp4": [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], [0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70], [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]],
  "audio/mpeg": [[0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2], [0x49, 0x44, 0x33]],
  "text/plain": null, // no signature; allow
};

function readHeader(filePath, bytes = 16) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function matches(buf, signature) {
  if (buf.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buf[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Verify that the file's content matches its declared MIME type via magic bytes.
 * Returns true if valid, false if mismatched.
 * Unknown / textual MIME types pass by default.
 */
function validateFileContent(filePath, declaredMime) {
  const sigs = SIGNATURES[declaredMime];
  if (sigs === undefined) return true; // unknown declared type — defer
  if (sigs === null) return true; // explicitly skip (e.g., text/plain)
  try {
    const header = readHeader(filePath);
    return sigs.some((sig) => matches(header, sig));
  } catch {
    return false;
  }
}

module.exports = { validateFileContent };
