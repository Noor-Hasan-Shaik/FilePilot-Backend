const { landingPages } = require("../models/db");
const logger = require("../utils/logger");

const DEFAULTS = [
  {
    slug: "compress-pdf-online-free",
    title: "Compress PDF Online Free — India | FilePilot",
    h1: "Compress PDF Online Free for Indian Users",
    description:
      "Reduce PDF file size online for free. Perfect for government forms, job applications, and document submissions in India. No signup required.",
    tool_link: "/tool/pdf-compress",
    tool_name: "PDF Compressor",
    keywords: "compress pdf online free India, reduce pdf size, pdf compressor free, compress pdf under 1mb",
    faqs: [
      { q: "Is it free to compress PDFs?", a: "Yes, FilePilot lets you compress PDFs for free with no signup required." },
      { q: "Is my file safe?", a: "Absolutely. Your files are processed in your browser and never uploaded to any server." },
      { q: "Can I compress PDF under 1MB?", a: "Yes! Use the High compression level to get the smallest possible file size." },
      { q: "Does it work on mobile?", a: "Yes, FilePilot is fully optimized for mobile devices." },
    ],
    published: true,
  },
  {
    slug: "convert-jpg-to-pdf-under-1mb",
    title: "Convert JPG to PDF Under 1MB Free | FilePilot",
    h1: "Convert JPG to PDF Under 1MB — Free Online Tool",
    description:
      "Convert your JPG images to PDF documents under 1MB. Ideal for Indian government form submissions and job applications.",
    tool_link: "/tool/jpg-to-pdf",
    tool_name: "JPG to PDF Converter",
    keywords: "convert jpg to pdf under 1mb, jpg to pdf free, image to pdf India, photo to pdf online",
    faqs: [
      { q: "How do I keep the PDF under 1MB?", a: "Compress your images before converting, or use our Image Compressor tool first." },
      { q: "Can I convert multiple images?", a: "Yes! Select multiple JPG images and they will be combined into one PDF." },
      { q: "Which image formats are supported?", a: "JPG, JPEG, PNG, and WebP formats are all supported." },
    ],
    published: true,
  },
  {
    slug: "resize-image-to-100kb",
    title: "Resize Image to 100KB Free Online | FilePilot",
    h1: "Resize Image to 100KB — Free Online Tool",
    description:
      "Resize and compress images to exactly 100KB or any size. Perfect for passport photos, ID cards, and online applications in India.",
    tool_link: "/tool/image-compress",
    tool_name: "Image Compressor",
    keywords: "resize image to 100kb, compress image 100kb, reduce image size online free, passport photo resize",
    faqs: [
      { q: "Can I resize to exactly 100KB?", a: "Use our Image Compressor with High compression to get close to your target size." },
      { q: "What about passport photo size?", a: "Use the Image Resizer tool to set exact dimensions (e.g., 600x600 pixels)." },
    ],
    published: true,
  },
];

function seedLandingPages() {
  let inserted = 0;
  for (const def of DEFAULTS) {
    if (!landingPages.findBySlug(def.slug)) {
      landingPages.create(def);
      inserted += 1;
    }
  }
  if (inserted > 0) logger.info(`Landing pages seeded (${inserted} new)`);
}

module.exports = { seedLandingPages };
