const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { JobQueue } = require("./jobQueue");
const { outputPathFor } = require("../utils/outputPath");
const logger = require("../utils/logger");

ffmpeg.setFfmpegPath(ffmpegPath);

// 100 req/min is the headline budget — but a 60-second clip can take 5–10s of
// CPU on its own. A tight queue keeps p95 latency sane and lets the rest of
// the API stay responsive. Adjust per box; 2 is conservative for 2-vCPU.
const queue = new JobQueue({ name: "media", concurrency: 2, defaultTimeoutMs: 5 * 60_000 });

// Hard caps so no single user pins the queue.
const MAX_INPUT_DURATION_SEC = 120;     // 2 min input cap
const GIF_MAX_DIMENSION = 800;
const GIF_MAX_FPS = 20;
const GIF_DEFAULT_FPS = 12;

function probe(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

async function assertInputDuration(inputPath) {
  let meta;
  try {
    meta = await probe(inputPath);
  } catch {
    // Some MP3 files lack metadata ffprobe can read; skip the check and let
    // the timeout catch anything pathological.
    return;
  }
  const dur = meta?.format?.duration;
  if (typeof dur === "number" && dur > MAX_INPUT_DURATION_SEC) {
    const err = new Error(`Input too long (${Math.round(dur)}s); max ${MAX_INPUT_DURATION_SEC}s`);
    err.status = 413;
    throw err;
  }
}

/**
 * Extract audio from a video file as MP3 (libmp3lame).
 */
exports.extractAudio = async (inputPath, { bitrate = "128k" } = {}) => {
  await assertInputDuration(inputPath);
  const outputPath = outputPathFor(inputPath, "audio", ".mp3");
  return queue.run(() => new Promise((resolve, reject) => {
    let command;
    try {
      command = ffmpeg(inputPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .audioBitrate(bitrate)
        .format("mp3")
        .on("error", (err) => reject(err))
        .on("end", () => resolve(outputPath))
        .save(outputPath);
    } catch (e) {
      reject(e);
    }
    return () => { try { command && command.kill("SIGKILL"); } catch {} };
  }), {
    onCancel: () => logger.warn("Audio extraction timed out", { inputPath }),
  });
};

/**
 * Convert video to GIF using the standard two-pass palette technique.
 * fps/scale clamped to keep file size bounded.
 */
exports.videoToGif = async (inputPath, { fps = GIF_DEFAULT_FPS, width = 480 } = {}) => {
  await assertInputDuration(inputPath);
  const safeFps = Math.max(2, Math.min(GIF_MAX_FPS, Number(fps) || GIF_DEFAULT_FPS));
  const safeWidth = Math.max(80, Math.min(GIF_MAX_DIMENSION, Number(width) || 480));
  const outputPath = outputPathFor(inputPath, "video", ".gif");

  // Standard high-quality GIF filtergraph: build a palette, then map to it.
  // `palettegen + paletteuse` in one chain is far smaller and cleaner than
  // running with the default 256-color quantization.
  const filter = `fps=${safeFps},scale=${safeWidth}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;

  return queue.run(() => new Promise((resolve, reject) => {
    let command;
    try {
      command = ffmpeg(inputPath)
        .outputOptions(["-vf", filter, "-loop", "0"])
        .format("gif")
        .on("error", (err) => reject(err))
        .on("end", () => resolve(outputPath))
        .save(outputPath);
    } catch (e) {
      reject(e);
    }
    return () => { try { command && command.kill("SIGKILL"); } catch {} };
  }), {
    onCancel: () => logger.warn("GIF conversion timed out", { inputPath }),
  });
};

exports.queueStats = () => queue.stats();
exports.MAX_INPUT_DURATION_SEC = MAX_INPUT_DURATION_SEC;
