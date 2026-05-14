const express = require("express");
const router = express.Router();
const { landingPages } = require("../models/db");

function publicShape(p) {
  if (!p) return null;
  return {
    slug: p.slug,
    title: p.title,
    h1: p.h1,
    description: p.description,
    tool_link: p.tool_link,
    tool_name: p.tool_name,
    keywords: p.keywords,
    faqs: p.faqs || [],
    meta_title: p.meta_title,
    meta_description: p.meta_description,
    og_image: p.og_image,
    published_at: p.published_at || p.created_at,
  };
}

router.get("/", (req, res, next) => {
  try {
    res.json(landingPages.findAll({ publishedOnly: true }).map(publicShape));
  } catch (err) {
    next(err);
  }
});

router.get("/:slug", (req, res, next) => {
  try {
    const p = landingPages.findBySlug(req.params.slug, { publishedOnly: true });
    if (!p) return res.status(404).json({ error: "Not found" });
    res.json(publicShape(p));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
