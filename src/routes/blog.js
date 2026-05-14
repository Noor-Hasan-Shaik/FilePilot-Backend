const express = require("express");
const router = express.Router();
const { blogPosts } = require("../models/db");
const { clampInt } = require("../utils/validators");

function publicShape(p) {
  if (!p) return null;
  return {
    slug: p.slug,
    title: p.title,
    excerpt: p.excerpt,
    content: p.content,
    author: p.author,
    cover_image_url: p.cover_image_url,
    tags: p.tags || [],
    published_at: p.published_at || p.created_at,
  };
}

// List published posts.
router.get("/", (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 100000);
    const rows = blogPosts.findAll({ publishedOnly: true, limit, offset });
    res.json(rows.map(publicShape));
  } catch (err) {
    next(err);
  }
});

router.get("/:slug", (req, res, next) => {
  try {
    const post = blogPosts.findBySlug(req.params.slug, { publishedOnly: true });
    if (!post) return res.status(404).json({ error: "Not found" });
    res.json(publicShape(post));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
