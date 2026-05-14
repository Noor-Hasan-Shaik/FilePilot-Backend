const { blogPosts } = require("../models/db");
const logger = require("../utils/logger");

const DEFAULTS = [
  {
    slug: "compress-pdf-online-free",
    title: "How to Compress PDF Online for Free in India",
    excerpt: "Learn the easiest ways to reduce PDF file size without losing quality. Perfect for students & professionals.",
    content: `Compressing PDFs is essential when you need to email documents, upload to government portals, or share on WhatsApp. Here's how to do it for free using FilePilot:\n\n1. Go to our PDF Compress tool\n2. Upload your PDF file\n3. Click 'Compress PDF'\n4. Download your smaller file\n\nOur tool works entirely in your browser — your files never leave your device. This makes it faster and more private than other online tools.\n\n**Tips for better compression:**\n- Remove unnecessary images from your PDF\n- Use our tool multiple times for maximum compression\n- For scanned documents, try reducing DPI before converting to PDF`,
    tags: ["pdf", "compress"],
    published: true,
    published_at: "2026-04-01 09:00:00",
  },
  {
    slug: "reduce-image-size",
    title: "Reduce Image Size Without Losing Quality — Complete Guide",
    excerpt: "Discover the best techniques to compress images for WhatsApp, email, and web use.",
    content: `Large images can slow down websites, fill up storage, and make sharing difficult. Here's how to reduce image size effectively:\n\n**Method 1: Use FilePilot Image Compressor**\nOur browser-based tool lets you adjust quality from 10% to 100%, giving you full control over the file size vs quality trade-off.\n\n**Method 2: Resize Images**\nOften, images are much larger than needed. A 4000x3000 photo can be resized to 1920x1080 for web use, reducing file size by 75%.\n\n**Method 3: Convert Format**\nJPG files are typically smaller than PNG. If your image doesn't need transparency, convert PNG to JPG for instant savings.`,
    tags: ["image", "compress"],
    published: true,
    published_at: "2026-03-28 09:00:00",
  },
  {
    slug: "convert-jpg-to-pdf-under-1mb",
    title: "Convert JPG to PDF Under 1MB — Step-by-Step",
    excerpt: "Need to submit documents under 1MB? Here is how to convert and compress JPG to PDF quickly.",
    content: `Many Indian government portals and job applications require documents under 1MB. Here's how to convert JPG to PDF and keep it under 1MB:\n\n1. **Compress your JPG first** — Use our Image Compressor to reduce the JPG file size\n2. **Convert to PDF** — Use our JPG to PDF tool\n3. **If still too large** — Use our PDF Compress tool\n\n**Pro tips:**\n- Scan documents at 150 DPI instead of 300 DPI\n- Use grayscale for text documents\n- Crop unnecessary white space before converting`,
    tags: ["pdf", "jpg"],
    published: true,
    published_at: "2026-03-25 09:00:00",
  },
  {
    slug: "merge-pdf-files-free",
    title: "How to Merge PDF Files Online — Free & Fast",
    excerpt: "Combine multiple PDFs into one document in seconds. No signup, no watermark.",
    content: `Need to combine multiple PDF files into one? FilePilot's PDF Merge tool makes it simple:\n\n1. Select multiple PDF files\n2. Arrange them in the order you want\n3. Click 'Merge PDFs'\n4. Download your combined document\n\n**Common use cases:**\n- Combining resume and certificates for job applications\n- Merging invoice pages\n- Creating a single document from scanned pages\n\nAll processing happens in your browser — your files are never uploaded to any server.`,
    tags: ["pdf", "merge"],
    published: true,
    published_at: "2026-03-20 09:00:00",
  },
  {
    slug: "ai-tools-file-processing",
    title: "AI-Powered File Processing — The Future of Document Management",
    excerpt: "Explore how AI tools can summarize documents, extract text from images, and generate notes automatically.",
    content: `Artificial Intelligence is revolutionizing how we work with files. FilePilot offers several AI-powered tools:\n\n**AI Document Summarizer** — Upload any document and get a concise summary in seconds.\n\n**AI OCR** — Extract text from images, screenshots, and scanned documents with high accuracy.\n\n**AI Notes Generator** — Convert any document into organized study notes.\n\n**AI Resume Builder** — Create professional resumes with AI-powered suggestions.\n\nThese tools save hours of manual work and are perfect for students, researchers, and professionals.`,
    tags: ["ai"],
    published: true,
    published_at: "2026-03-15 09:00:00",
  },
];

function seedBlogPosts() {
  let inserted = 0;
  for (const def of DEFAULTS) {
    const before = blogPosts.findBySlug(def.slug);
    if (!before) {
      blogPosts.create(def);
      inserted += 1;
    }
  }
  if (inserted > 0) logger.info(`Blog posts seeded (${inserted} new)`);
}

module.exports = { seedBlogPosts };
