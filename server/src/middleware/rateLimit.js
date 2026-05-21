// In-memory per-IP rate limiter.
//
// Stores recent request timestamps per client IP in a Map. On each request,
// prunes timestamps outside the configured window, then checks count against
// max. Reaches into X-Forwarded-For for the client IP in production
// (Railway terminates SSL upstream).
//
// State lives in process memory: on Railway restart, counters reset. That's
// acceptable for the threat model — the keyphrase is the real gate; rate limit
// is the second line of defense against a leaked keyphrase being used to burn
// API credit. Single Railway instance, so no need for Redis.
//
// A periodic cleanup task drops idle IPs from the Map every hour so memory
// usage stays bounded.

const buckets = new Map(); // ip -> number[] (timestamps)

const MAX_TRACKED_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h — matches the longest window we use
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;        // 1h

setInterval(() => {
  const cutoff = Date.now() - MAX_TRACKED_WINDOW_MS;
  for (const [ip, timestamps] of buckets.entries()) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) {
      buckets.delete(ip);
    } else if (recent.length !== timestamps.length) {
      buckets.set(ip, recent);
    }
  }
}, CLEANUP_INTERVAL_MS).unref(); // unref so this timer doesn't keep the process alive on shutdown

function getClientIp(req) {
  // In production behind Railway's proxy, X-Forwarded-For contains the real IP.
  // Express sets req.ip correctly when 'trust proxy' is set on the app, which
  // /server/src/index.js does in production. Use req.ip for both environments.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Returns an Express middleware that enforces `max` requests per `windowMs`
 * per client IP. 429 response includes retryAfterMs.
 *
 * @param {{ max: number, windowMs: number }} options
 */
export function rateLimit({ max, windowMs }) {
  if (typeof max !== 'number' || max <= 0) throw new Error('rateLimit: max must be a positive number');
  if (typeof windowMs !== 'number' || windowMs <= 0) throw new Error('rateLimit: windowMs must be a positive number');

  return (req, res, next) => {
    const ip = getClientIp(req);
    const now = Date.now();
    const cutoff = now - windowMs;

    const existing = buckets.get(ip) || [];
    const recent = existing.filter((t) => t > cutoff);

    if (recent.length >= max) {
      const oldestRetained = recent[0];
      const retryAfterMs = Math.max(0, oldestRetained + windowMs - now);
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfterMs,
      });
    }

    recent.push(now);
    buckets.set(ip, recent);
    next();
  };
}
