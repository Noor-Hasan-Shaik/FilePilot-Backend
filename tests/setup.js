const fs = require("fs");
const path = require("path");
const os = require("os");

// Each test run gets a fresh temp SQLite file so tests are deterministic and
// never touch the dev database. We also fix JWT_SECRET so login produces a
// stable token.
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "filepilot-test-"));
process.env.DB_PATH = path.join(testDir, "test.db");
process.env.JWT_SECRET = "test-secret-must-be-at-least-32-chars-long";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error"; // keep test output clean
process.env.DEFAULT_USER_PASSWORD = "Filepilot@26";
process.env.SEED_DEFAULT_USERS = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_SECRET;

module.exports = { testDir };
