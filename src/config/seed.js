const bcrypt = require("bcryptjs");
const { users, plans, toolAccess, toolsConfig } = require("../models/db");
const { seedSiteSettings } = require("./seedSiteSettings");
const { seedBlogPosts } = require("./seedBlog");
const { seedLandingPages } = require("./seedLandingPages");

const DEFAULT_USERS = [
  { email: "admin@filepilot.com", name: "Admin", plan: "admin" },
  { email: "business@filepilot.com", name: "Business", plan: "business" },
  { email: "pro@filepilot.com", name: "Pro", plan: "pro" },
  { email: "free@filepilot.com", name: "Free", plan: "free" },
];

const DEFAULT_PLANS = [
  { name: "free", display_name: "Free", price: 0, period: "month", description: "Best for trying out basic tools", daily_limit: 5, max_file_size_mb: 25, retention_hours: 1, features: ["5 tasks/day", "Basic tools (PDF, Image)", "Watermark on output", "Max file size 25MB", "Files kept 1 hour"], sort_order: 0, cta_text: "Get Started" },
  { name: "starter", display_name: "Starter", price: 19900, period: "month", description: "Perfect for students & freelancers", daily_limit: 50, max_file_size_mb: 100, retention_hours: 6, features: ["50 tasks/day", "No watermark", "File size up to 100MB", "Basic batch processing", "Files kept 6 hours"], sort_order: 1, cta_text: "Upgrade to Starter" },
  { name: "pro", display_name: "Pro", price: 49900, period: "month", description: "Best for creators & developers", daily_limit: -1, max_file_size_mb: 1024, retention_hours: 24, features: ["Unlimited tasks (fair usage)", "All tools unlocked", "Batch processing", "File size up to 1GB", "Priority processing", "Files kept 24 hours"], is_popular: 1, sort_order: 2, cta_text: "Go Pro" },
  { name: "business", display_name: "Business", price: 149900, period: "month", description: "For teams & agencies", daily_limit: -1, max_file_size_mb: 2048, retention_hours: 168, features: ["Everything in Pro", "5 team members", "API access (limited)", "Custom branding (white-label)", "Advanced AI tools", "Files kept 7 days"], sort_order: 3, cta_text: "Upgrade to Business" },
  { name: "enterprise", display_name: "Enterprise", price: 0, period: "", description: "For large companies & SaaS", daily_limit: -1, max_file_size_mb: 0, retention_hours: 720, features: ["Unlimited team members", "Full API access", "Dedicated infrastructure", "Custom integrations", "SLA + premium support", "Files kept 30 days"], is_enterprise: 1, sort_order: 4, cta_text: "Contact Sales" },
];

const DEFAULT_TOOLS = [
  // PDF
  { title: "PDF to Word", route: "/tool/pdf-to-word", category: "pdf", description: "Convert PDF to editable Word", icon: "FileOutput", sort_order: 0 },
  { title: "Word to PDF", route: "/tool/word-to-pdf", category: "pdf", description: "Convert Word to PDF", icon: "FileInput", sort_order: 1 },
  { title: "Merge PDF", route: "/tool/pdf-merge", category: "pdf", description: "Combine multiple PDFs", icon: "Merge", sort_order: 2 },
  { title: "Split PDF", route: "/tool/pdf-split", category: "pdf", description: "Split PDF pages", icon: "Scissors", sort_order: 3 },
  { title: "Compress PDF", route: "/tool/pdf-compress", category: "pdf", description: "Reduce PDF size", icon: "Minimize2", sort_order: 4 },
  { title: "PDF to JPG", route: "/tool/pdf-to-jpg", category: "pdf", description: "Convert PDF to images", icon: "Image", sort_order: 5 },
  { title: "PDF to PNG", route: "/tool/pdf-to-png", category: "pdf", description: "Convert PDF to PNG images", icon: "Image", sort_order: 12 },
  { title: "JPG to PDF", route: "/tool/jpg-to-pdf", category: "pdf", description: "Convert images to PDF", icon: "FileImage", sort_order: 6 },
  { title: "Add Watermark", route: "/tool/add-watermark", category: "pdf", description: "Add watermark to PDF", icon: "Droplets", sort_order: 7 },
  { title: "Remove Pages", route: "/tool/remove-pages", category: "pdf", description: "Delete PDF pages", icon: "Trash2", sort_order: 8 },
  { title: "Rotate PDF", route: "/tool/rotate-pdf", category: "pdf", description: "Rotate PDF pages", icon: "RotateCw", sort_order: 9 },
  { title: "Text to PDF", route: "/tool/text-to-pdf", category: "pdf", description: "Convert text or DOCX into PDF", icon: "FileText", sort_order: 10 },
  { title: "Text to Excel/Pdf", route: "/tool/TextToExcelPdf", category: "pdf", description: "Convert text into Excel/PDF", icon: "FileText", sort_order: 11 },

  // Image
  { title: "Image Compressor", route: "/tool/image-compress", category: "image", description: "Compress images", icon: "ImageDown", sort_order: 0 },
  { title: "Resize Image", route: "/tool/image-resize", category: "image", description: "Resize images", icon: "Maximize2", sort_order: 1 },
  { title: "Crop Image", route: "/tool/crop-image", category: "image", description: "Crop images easily", icon: "Crop", sort_order: 2 },
  { title: "PNG to JPG", route: "/tool/convert-png-jpg", category: "image", description: "Convert formats", icon: "RefreshCw", sort_order: 3 },
  { title: "Background Remover", route: "/tool/remove-bg", category: "image", description: "Remove background", icon: "Eraser", sort_order: 4 },
  { title: "Image to PDF", route: "/tool/image-to-pdf", category: "image", description: "Images to PDF", icon: "FileImage", sort_order: 5 },
  { title: "Image Merger", route: "/tool/image-merger", category: "image", description: "Merge images", icon: "Images", sort_order: 6 },
  { title: "Image Enhancer", route: "/tool/image-enhancer", category: "image", description: "Enhance quality", icon: "Sparkles", sort_order: 7 },
  { title: "Image to PNG", route: "/tool/image-to-png", category: "image", description: "Convert to PNG", icon: "Image", sort_order: 8 },

  // Conversion
  { title: "Video to MP3", route: "/tool/video-to-mp3", category: "conversion", description: "Extract audio", icon: "Video", sort_order: 0 },
  { title: "MP4 to GIF", route: "/tool/mp4-to-gif", category: "conversion", description: "Convert to GIF", icon: "Film", sort_order: 1 },
  { title: "DOCX to TXT", route: "/tool/docx-to-txt", category: "conversion", description: "Doc to text", icon: "FileType", sort_order: 2 },
  { title: "Excel to PDF", route: "/tool/excel-to-pdf", category: "conversion", description: "Excel to PDF", icon: "Sheet", sort_order: 3 },
  { title: "PPT to PDF", route: "/tool/ppt-to-pdf", category: "conversion", description: "PPT to PDF", icon: "Presentation", sort_order: 4 },

  // AI
  { title: "Resume PDF Builder", route: "/tool/ai-resume", category: "ai", description: "Fill a form, download a clean PDF resume", icon: "Brain", sort_order: 0 },
  { title: "AI Image Upscaler", route: "/tool/ai-upscale", category: "ai", description: "Upscale images", icon: "ZoomIn", sort_order: 1 },
  { title: "AI Summarizer", route: "/tool/ai-summarizer", category: "ai", description: "Summarize text", icon: "BookOpen", sort_order: 2 },
  { title: "AI OCR", route: "/tool/ai-ocr", category: "ai", description: "Extract text", icon: "ScanText", sort_order: 3 },
  { title: "AI Signature", route: "/tool/ai-signature", category: "ai", description: "Generate signature", icon: "PenTool", sort_order: 4 },
  { title: "Notes Formatter", route: "/tool/ai-notes", category: "ai", description: "Reformat text into bullets and headings", icon: "NotebookPen", sort_order: 5 },
  { title: "AI Cam Scanner", route: "/tool/ai-cam-scanner", category: "ai", description: "Scan documents using AI", icon: "Camera", sort_order: 6 },

  // Utility
  { title: "QR Code Generator", route: "/tool/qr-code", category: "utility", description: "Create QR codes", icon: "QrCode", sort_order: 0 },
  { title: "Password Generator", route: "/tool/password-generator", category: "utility", description: "Generate passwords", icon: "Lock", sort_order: 1 },
  { title: "Text Case Converter", route: "/tool/text-case", category: "utility", description: "Convert text case", icon: "CaseSensitive", sort_order: 2 },
  { title: "JSON Formatter", route: "/tool/json", category: "utility", description: "Format JSON", icon: "Braces", sort_order: 3 },
  { title: "Unit Converter", route: "/tool/unit", category: "utility", description: "Convert units", icon: "Ruler", sort_order: 4 },
  { title: "Base64 Tool", route: "/tool/base64", category: "utility", description: "Encode/decode Base64", icon: "Binary", sort_order: 5 },
  { title: "Color Picker", route: "/tool/color-picker", category: "utility", description: "Pick colors", icon: "Palette", sort_order: 6 },
  { title: "Lorem Generator", route: "/tool/lorem-generator", category: "utility", description: "Generate dummy text", icon: "FileText", sort_order: 7 },
  { title: "Word Counter", route: "/tool/word-counter", category: "utility", description: "Count words", icon: "AlignLeft", sort_order: 8 },
  { title: "Hash Generator", route: "/tool/hash-generator", category: "utility", description: "Generate hash", icon: "Hash", sort_order: 9 },
  { title: "Markdown Editor", route: "/tool/markdown-editor", category: "utility", description: "Write & preview markdown", icon: "FilePenLine", sort_order: 10 },
  { title: "Barcode Generator", route: "/tool/barcode-generator", category: "utility", description: "Generate barcodes", icon: "Barcode", sort_order: 11 },
  { title: "Barcode Scanner", route: "/tool/barcode-scanner", category: "utility", description: "Scan barcodes via camera", icon: "ScanLine", sort_order: 12 },
];

// Tool routes accessible by each plan (cumulative)
const FREE_TOOLS = [
  "/tool/qr-code", "/tool/password-generator", "/tool/text-case",
  "/tool/json", "/tool/unit", "/tool/base64", "/tool/color-picker",
  "/tool/lorem-generator", "/tool/word-counter", "/tool/hash-generator",
  "/tool/markdown-editor", "/tool/barcode-generator", "/tool/barcode-scanner",
  "/tool/docx-to-txt", "/tool/ai-notes",
];

const STARTER_TOOLS = [
  ...FREE_TOOLS,
  "/tool/pdf-compress", "/tool/pdf-merge", "/tool/pdf-split",
  "/tool/pdf-to-jpg", "/tool/pdf-to-png", "/tool/jpg-to-pdf", "/tool/rotate-pdf",
  "/tool/add-watermark", "/tool/remove-pages", "/tool/text-to-pdf",
  "/tool/TextToExcelPdf",
  "/tool/image-compress", "/tool/image-resize", "/tool/crop-image",
  "/tool/convert-png-jpg", "/tool/image-to-pdf", "/tool/image-merger",
  "/tool/image-to-png",
  "/tool/video-to-mp3", "/tool/mp4-to-gif", "/tool/excel-to-pdf",
  "/tool/ppt-to-pdf",
];

const PRO_TOOLS = [
  ...STARTER_TOOLS,
  "/tool/pdf-to-word", "/tool/word-to-pdf",
  "/tool/remove-bg", "/tool/image-enhancer",
  "/tool/ai-summarizer", "/tool/ai-cam-scanner",
];

const BUSINESS_TOOLS = [
  ...PRO_TOOLS,
  "/tool/ai-resume", "/tool/ai-upscale", "/tool/ai-ocr",
  "/tool/ai-signature",
];

const TOOL_ACCESS_MAP = {
  free: FREE_TOOLS,
  starter: STARTER_TOOLS,
  pro: PRO_TOOLS,
  business: BUSINESS_TOOLS,
  enterprise: BUSINESS_TOOLS,
  admin: BUSINESS_TOOLS,
};

// Values that look like .env placeholders rather than real secrets — the seed
// should ignore these and fall back to the dev default so the demo bubble works.
function looksLikePlaceholder(v) {
  if (typeof v !== "string") return true;
  const s = v.trim();
  if (!s) return true;
  if (/^your[_-]/i.test(s)) return true;
  if (/^changeme/i.test(s)) return true;
  if (/^placeholder/i.test(s)) return true;
  return false;
}

function seedDefaultUsers() {
  const isProd = process.env.NODE_ENV === "production";
  const forceSeed = process.env.SEED_DEFAULT_USERS === "true";

  if (isProd && !forceSeed) {
    console.log("Default users NOT seeded (production). Set SEED_DEFAULT_USERS=true to enable.");
    return;
  }

  const envPassword = process.env.DEFAULT_USER_PASSWORD;
  const usePlaceholder = looksLikePlaceholder(envPassword);

  if (isProd) {
    if (usePlaceholder || envPassword.length < 12) {
      console.error("[FATAL] In production, DEFAULT_USER_PASSWORD must be a real value (>=12 chars) when SEED_DEFAULT_USERS=true");
      process.exit(1);
    }
  }

  const password = usePlaceholder ? "Filepilot@26" : envPassword;
  if (usePlaceholder && envPassword) {
    console.warn("DEFAULT_USER_PASSWORD looks like a placeholder — using built-in dev password 'Filepilot@26'");
  }
  const hashedPassword = bcrypt.hashSync(password, 10);
  for (const defaultUser of DEFAULT_USERS) {
    users.upsertByEmail(defaultUser.email, {
      name: defaultUser.name, plan: defaultUser.plan, password: hashedPassword,
      is_verified: 1, otp: null, otp_expiry: null, reset_otp: null, reset_otp_expiry: null,
    });
  }
  console.log(`Default user accounts seeded (${DEFAULT_USERS.length})`);
}

function seedPlans() {
  const existing = plans.findAll();
  if (existing.length === 0) {
    for (const plan of DEFAULT_PLANS) plans.create(plan);
    console.log("Default plans seeded");
    return;
  }
  // Backfill retention_hours for plans that pre-date the column. Only touch
  // rows that still have the schema default (1) and whose name matches a
  // baked-in plan — never overwrite an admin's custom value.
  for (const def of DEFAULT_PLANS) {
    const row = plans.findByName(def.name);
    if (row && (!row.retention_hours || row.retention_hours === 1) && def.retention_hours && def.retention_hours !== 1) {
      plans.update(row.id, { retention_hours: def.retention_hours });
    }
  }
}

function seedToolAccess() {
  const existing = require("../config/database").getDB()
    .prepare("SELECT COUNT(*) as c FROM tool_access").get().c;
  if (existing > 0) return;
  for (const [planName, routes] of Object.entries(TOOL_ACCESS_MAP)) {
    toolAccess.setForPlan(planName, routes);
  }
  console.log("Default tool access seeded");
}

function seedTools() {
  const existing = toolsConfig.findAll();
  if (existing.length > 0) return;
  for (const tool of DEFAULT_TOOLS) {
    toolsConfig.create(tool);
  }
  console.log("Default tools seeded (" + DEFAULT_TOOLS.length + " tools)");
}

function seedAll() {
  seedDefaultUsers();
  seedPlans();
  seedTools();
  seedToolAccess();
  seedSiteSettings();
  seedBlogPosts();
  seedLandingPages();
}

module.exports = seedAll;
