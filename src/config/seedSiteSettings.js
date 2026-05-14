const { siteSettings } = require("../models/db");
const logger = require("../utils/logger");

const DEFAULTS = [
  // ─── Brand ────────────────────────────────
  { key: "brand.name", value: "TryFilePilot", description: "Site brand name" },
  {
    key: "brand.tagline",
    value: "Smart tools to manage, convert and optimize your files effortlessly.",
    description: "Short tagline shown in footer/header",
  },
  { key: "brand.logo_url", value: "", description: "Optional custom logo URL" },

  // ─── Hero ────────────────────────────────
  {
    key: "hero.telegram_link",
    value: "https://t.me/kepfilepilotbot",
    description: "Telegram bot deeplink used on the homepage",
  },
  {
    key: "hero.features",
    value: [
      { icon: "Zap", title: "Lightning Fast", description: "Process files in seconds with our optimized engine." },
      { icon: "Shield", title: "Secure & Private", description: "Your files are encrypted and deleted automatically." },
      { icon: "Smartphone", title: "Mobile Ready", description: "Works on any device, anywhere, anytime." },
    ],
    description: "Cards rendered on landing page",
  },
  {
    key: "hero.trust_signals",
    value: [
      "100% Free to start",
      "No credit card required",
      "GDPR-compliant",
      "Files auto-deleted in 1 hour",
    ],
    description: "Short trust copy under the hero",
  },

  // ─── Header ──────────────────────────────
  {
    key: "header.nav_links",
    value: [
      { label: "Home", href: "/" },
      { label: "Tools", href: "/tools" },
      { label: "WhatsApp", href: "/whatsapp" },
      { label: "Telegram", href: "/telegram" },
      { label: "Pricing", href: "/pricing" },
      { label: "Blog", href: "/blog" },
    ],
    description: "Top navigation links",
  },

  // ─── Footer ──────────────────────────────
  {
    key: "footer.sections",
    value: [
      {
        title: "Product",
        links: [
          { label: "Home", href: "/" },
          { label: "Tools", href: "/tools" },
          { label: "WhatsApp", href: "/whatsapp" },
          { label: "Telegram", href: "/telegram" },
          { label: "Pricing", href: "/pricing" },
          { label: "Blog", href: "/blog" },
        ],
      },
      {
        title: "Resources",
        links: [
          { label: "Desktop", href: "/" },
          { label: "Mobile", href: "/" },
          { label: "Sign In", href: "/login" },
          { label: "API", href: "/" },
          { label: "Image Tools", href: "/tools/image" },
        ],
      },
      {
        title: "Solutions",
        links: [
          { label: "Business", href: "/" },
          { label: "Education", href: "/" },
          { label: "Freelancing", href: "/" },
        ],
      },
      {
        title: "SEO",
        links: [
          { label: "Compress PDF", href: "/compress-pdf-online-free" },
          { label: "JPG to PDF", href: "/convert-jpg-to-pdf-under-1mb" },
          { label: "Resize Image", href: "/resize-image-to-100kb" },
        ],
      },
      {
        title: "Support",
        links: [
          { label: "Contact", href: "/contact" },
          { label: "Help Center", href: "/support" },
          { label: "Feedback", href: "/feedback" },
        ],
      },
    ],
    description: "Footer column groups",
  },
  {
    key: "footer.social",
    value: [
      { icon: "Instagram", href: "https://www.instagram.com/keshavaeliteprojects/", label: "Instagram" },
      { icon: "Linkedin", href: "https://www.linkedin.com/company/keshava-elite-projects/", label: "LinkedIn" },
      { icon: "Facebook", href: "https://www.facebook.com/keshavaeliteprojects/", label: "Facebook" },
      { icon: "Share2", href: "https://wa.me/1111111111", label: "WhatsApp" },
    ],
    description: "Social links shown in the footer",
  },
  {
    key: "footer.legal_links",
    value: [
      { label: "Privacy", href: "/privacy-policy" },
      { label: "Terms", href: "/terms-of-service" },
      { label: "Cookies", href: "/cookie-policy" },
      { label: "Refund", href: "/refund-policy" },
      { label: "Data Deletion", href: "/data-deletion" },
    ],
    description: "Bottom-row legal links",
  },
  { key: "footer.copyright", value: "© {year} TryFilePilot", description: "Copyright text; {year} is replaced at render" },
  {
    key: "footer.app_buttons",
    value: [
      { label: "App Store", href: "/" },
      { label: "Google Play", href: "/" },
      { label: "Microsoft", href: "/" },
    ],
    description: "Store/download buttons",
  },

  // ─── Contact ─────────────────────────────
  { key: "contact.support_email", value: "support@tryfilepilot.com", description: "Public support email" },
  { key: "contact.support_phone", value: "", description: "Optional public support phone" },
  { key: "contact.whatsapp_number", value: "", description: "Phone number for wa.me deeplink (no +)" },
  { key: "contact.telegram_bot_username", value: "kepfilepilotbot", description: "Telegram bot @ username (no @)" },

  // ─── WhatsApp section ────────────────────
  {
    key: "whatsapp.steps",
    value: [
      { icon: "Send", title: "Send File", description: "Forward any file to our bot" },
      { icon: "Bot", title: "Auto Detect", description: "We pick the right tool automatically" },
      { icon: "Cpu", title: "Process", description: "Conversion happens in seconds" },
      { icon: "Download", title: "Download", description: "Receive the result back in chat" },
    ],
    description: "Step cards on the WhatsApp section",
  },
  { key: "whatsapp.coming_soon_message", value: "WhatsApp integration is on the way", description: "Shown when WA is disabled" },

  // ─── Telegram section ────────────────────
  {
    key: "telegram.steps",
    value: [
      { icon: "MessageCircle", title: "Open Bot", description: "Tap the link to start a chat" },
      { icon: "Upload", title: "Send File", description: "Share any supported file" },
      { icon: "Cpu", title: "Auto Process", description: "Bot picks the right tool" },
      { icon: "Download", title: "Get Result", description: "Receive the output instantly" },
    ],
    description: "Step cards on the Telegram bot page",
  },

  // ─── Daily limits (replaces frontend constants) ──
  { key: "limits.guest_daily", value: 3, description: "Per-day quota for unauthenticated visitors" },
  { key: "limits.free_user_daily", value: 5, description: "Default per-day quota for free-plan users" },

  // ─── Storage ─────────────────────────────────────
  { key: "storage.max_disk_gb", value: 10, description: "Total disk cap (GB) for uploads + outputs combined. Oldest files are evicted when exceeded." },

  // ─── SEO defaults ────────────────────────
  { key: "seo.default_title", value: "FilePilot — Smart File Tools", description: "Default <title>" },
  {
    key: "seo.default_description",
    value: "Convert, compress, and process files instantly with FilePilot.",
    description: "Default meta description",
  },
];

function seedSiteSettings() {
  let inserted = 0;
  for (const def of DEFAULTS) {
    const existed = !!siteSettings.get(def.key);
    siteSettings.setIfAbsent(def.key, def.value, { isPublic: true, description: def.description });
    if (!existed) inserted += 1;
  }
  if (inserted > 0) logger.info(`Site settings seeded (${inserted} new)`);
}

module.exports = { seedSiteSettings, DEFAULT_KEYS: DEFAULTS.map((d) => d.key) };
