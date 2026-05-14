/**
 * Tiny in-process job queue with concurrency cap + per-task timeout.
 *
 * Used to guard heavy tools (ffmpeg, LibreOffice) so a burst of users can't
 * pin every CPU core at once. Tasks beyond `concurrency` wait FIFO. Each task
 * is wrapped in Promise.race with `timeoutMs`; if the timeout fires, the
 * caller's promise rejects with a "Job timed out" error — the wrapped work
 * function is responsible for its own cancellation (e.g. ffmpeg .kill()) if
 * it wants to free resources sooner. We unblock the queue slot regardless.
 */
class JobQueue {
  constructor({ name = "queue", concurrency = 1, defaultTimeoutMs = 60_000 } = {}) {
    this.name = name;
    this.concurrency = Math.max(1, concurrency);
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.running = 0;
    this.pending = [];
  }

  /**
   * Run `fn` under the queue. `fn` may return a promise.
   * Optionally pass `onCancel` — called if the timeout fires, so the task
   * can kill its underlying process.
   */
  run(fn, { timeoutMs, onCancel } = {}) {
    return new Promise((resolve, reject) => {
      const launch = async () => {
        this.running += 1;
        let timer = null;
        let timedOut = false;
        try {
          const work = (async () => fn())();
          const result = await Promise.race([
            work,
            new Promise((_, rej) => {
              timer = setTimeout(() => {
                timedOut = true;
                try { if (typeof onCancel === "function") onCancel(); } catch {}
                const err = new Error("Job timed out");
                err.status = 504;
                rej(err);
              }, timeoutMs || this.defaultTimeoutMs);
              if (timer.unref) timer.unref();
            }),
          ]);
          if (timer) clearTimeout(timer);
          resolve(result);
          // Let the actual work finish in the background so any cleanup it
          // does still runs; just swallow any error since we already resolved.
          if (!timedOut) {
            // already settled above
          }
        } catch (e) {
          if (timer) clearTimeout(timer);
          reject(e);
        } finally {
          this.running -= 1;
          this._drain();
        }
      };

      if (this.running < this.concurrency) {
        launch();
      } else {
        this.pending.push(launch);
      }
    });
  }

  _drain() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift();
      next();
    }
  }

  stats() {
    return { name: this.name, running: this.running, pending: this.pending.length, concurrency: this.concurrency };
  }
}

module.exports = { JobQueue };
