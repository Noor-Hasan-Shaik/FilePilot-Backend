require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const http = require("http");
const { Server } = require("socket.io");

const { initDB, closeDB } = require("./config/database");
const seedAll = require("./config/seed");
const { PORT, CORS_ORIGINS, isProduction } = require("./config/constants");
const errorHandler = require("./middleware/errorHandler");
const { requireAuth, requireAdmin } = require("./middleware/auth");
const logger = require("./utils/logger");

const authRoutes = require("./routes/auth");
const paymentRoutes = require("./routes/payment");
const usageRoutes = require("./routes/usage");
const adminRoutes = require("./routes/admin");
const processRoutes = require("./routes/process");
const { router: downloadRoutes } = require("./routes/download");
const plansRoutes = require("./routes/plans");
const siteRoutes = require("./routes/site");
const blogRoutes = require("./routes/blog");
const landingRoutes = require("./routes/landing");
const dashboardRoutes = require("./routes/dashboard");
const clientErrorsRoutes = require("./routes/clientErrors");
const { startCleanupInterval } = require("./utils/cleanup");

const app = express();

app.set("trust proxy", 1);

// ---------------------
// Security & Performance Middleware
// ---------------------
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: isProduction
      ? {
          useDefaults: true,
          directives: {
            "default-src": ["'self'"],
            "img-src": ["'self'", "data:", "blob:", "https:"],
            "script-src": ["'self'", "https://checkout.razorpay.com", "https://accounts.google.com"],
            "style-src": ["'self'", "'unsafe-inline'"],
            "connect-src": ["'self'", "https://api.razorpay.com", "https://lumberjack.razorpay.com", "https://accounts.google.com", ...CORS_ORIGINS],
            "frame-src": ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com", "https://accounts.google.com"],
            "font-src": ["'self'", "data:"],
            "object-src": ["'none'"],
            "base-uri": ["'self'"],
            "form-action": ["'self'"],
            "frame-ancestors": ["'none'"],
          },
        }
      : false,
  })
);
app.use(compression());

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, !isProduction);
    if (CORS_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};

app.use(cors(corsOptions));

app.use(express.json({ limit: "10mb" }));

// ---------------------
// Rate Limiting
// ---------------------
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts, please try again later" },
});

const processLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many processing requests, please try again later" },
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment attempts, please try again later" },
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests, please try again later" },
});

app.use("/api", globalLimiter);

// ---------------------
// Routes
// ---------------------
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "FilePilot API running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/payment", paymentLimiter, requireAuth, paymentRoutes);
app.use("/api/usage", usageRoutes);
app.use("/api/admin", adminLimiter, requireAdmin, adminRoutes);
app.use("/api/process", processLimiter, processRoutes);
app.use("/api/download", downloadRoutes);
app.use("/api/plans", plansRoutes);
app.use("/api/site", siteRoutes);
app.use("/api/blog", blogRoutes);
app.use("/api/landing", landingRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/client-errors", clientErrorsRoutes);

// ---------------------
// Error Handler (must be after routes)
// ---------------------
app.use(errorHandler);

// ---------------------
// Socket.IO
// ---------------------
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("io", io);

io.on("connection", (socket) => {
  socket.on("disconnect", () => {});
});

// ---------------------
// Initialize DB & Start Server
// ---------------------
try {
  initDB();
  seedAll();

  startCleanupInterval();

  server.timeout = 5 * 60 * 1000;

  server.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
  });
} catch (err) {
  logger.error("Failed to start server", { error: err.message });
  process.exit(1);
}

// ---------------------
// Telegram Bot (optional)
// ---------------------
let telegram = { stop: async () => {} };
if (process.env.TELEGRAM_BOT_TOKEN) {
  try {
    telegram = require("./telegram/telegramBot");
  } catch (e) {
    logger.error("Failed to start Telegram bot", { error: e.message });
  }
}

// ---------------------
// Graceful Shutdown
// ---------------------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down`);
  server.close(async () => {
    try {
      io.close();
      if (telegram && typeof telegram.stop === "function") {
        await telegram.stop();
      }
      closeDB();
    } catch (e) {
      logger.error("Error during shutdown", { error: e.message });
    }
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("Force shutdown after 10s");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: String(reason) });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  shutdown("uncaughtException");
});
