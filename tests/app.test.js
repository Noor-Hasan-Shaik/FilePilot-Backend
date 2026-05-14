// Boot env BEFORE requiring anything that touches the DB.
require("./setup");

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { initDB, closeDB } = require("../src/config/database");
const seedAll = require("../src/config/seed");
const errorHandler = require("../src/middleware/errorHandler");
const { requireAdmin } = require("../src/middleware/auth");

const authRoutes = require("../src/routes/auth");
const usageRoutes = require("../src/routes/usage");
const adminRoutes = require("../src/routes/admin");
const plansRoutes = require("../src/routes/plans");
const siteRoutes = require("../src/routes/site");
const blogRoutes = require("../src/routes/blog");
const dashboardRoutes = require("../src/routes/dashboard");
const clientErrorsRoutes = require("../src/routes/clientErrors");

function buildApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRoutes);
  app.use("/api/usage", usageRoutes);
  app.use("/api/admin", requireAdmin, adminRoutes);
  app.use("/api/plans", plansRoutes);
  app.use("/api/site", siteRoutes);
  app.use("/api/blog", blogRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/client-errors", clientErrorsRoutes);

  app.use(errorHandler);
  return app;
}

let app;
let proToken;
let adminToken;

before(async () => {
  initDB();
  seedAll();
  app = buildApp();

  const proRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "pro@filepilot.com", password: "Filepilot@26" });
  proToken = proRes.body.token;

  const adminRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "admin@filepilot.com", password: "Filepilot@26" });
  adminToken = adminRes.body.token;
});

after(() => {
  try { closeDB(); } catch {}
});

describe("health + public endpoints", () => {
  test("GET /health returns ok", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });

  test("GET /api/site/settings returns seeded keys", async () => {
    const res = await request(app).get("/api/site/settings");
    assert.equal(res.status, 200);
    assert.ok(res.body["brand.name"]);
    assert.ok(Array.isArray(res.body["footer.sections"]));
  });

  test("GET /api/plans returns seeded plans", async () => {
    const res = await request(app).get("/api/plans");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.some((p) => p.name === "free"));
  });

  test("GET /api/blog returns published seed posts", async () => {
    const res = await request(app).get("/api/blog");
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    for (const post of res.body) {
      assert.equal(typeof post.slug, "string");
      assert.equal(typeof post.title, "string");
    }
  });
});

describe("auth + login", () => {
  test("rejects malformed email at signup", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ name: "X", email: "not-an-email", password: "longenoughpw" });
    assert.equal(res.status, 400);
  });

  test("rejects short password at signup", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ name: "X", email: "x@example.com", password: "short" });
    assert.equal(res.status, 400);
  });

  test("logs in the seeded admin user", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@filepilot.com", password: "Filepilot@26" });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.plan, "admin");
    assert.equal(typeof res.body.token, "string");
    assert.equal(typeof res.body.refreshToken, "string");
  });

  test("rejects invalid password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@filepilot.com", password: "wrong-password" });
    assert.equal(res.status, 400);
  });
});

describe("dashboard + admin gating", () => {
  test("rejects unauthenticated dashboard request", async () => {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 401);
  });

  test("returns pro-plan dashboard payload", async () => {
    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${proToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.plan.name, "pro");
    assert.equal(res.body.capabilities.billing, true);
    assert.equal(typeof res.body.retention_hours, "number");
  });

  test("rejects non-admin from /api/admin/users", async () => {
    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${proToken}`);
    assert.equal(res.status, 403);
  });

  test("admin can list users with no password leakage", async () => {
    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    for (const user of res.body) {
      assert.equal(user.password, undefined);
      assert.equal(user.otp, undefined);
      assert.equal(user.reset_otp, undefined);
    }
  });
});

describe("client error endpoint", () => {
  test("accepts a well-formed error report", async () => {
    const res = await request(app)
      .post("/api/client-errors")
      .send({ message: "test render error", route: "/tool/pdf-compress" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  test("rejects empty payload", async () => {
    const res = await request(app)
      .post("/api/client-errors")
      .send({});
    assert.equal(res.status, 400);
  });
});
