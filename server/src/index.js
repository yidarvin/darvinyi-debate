// Express server entry point.
//
// Responsibilities:
//   - Load env (dotenv)
//   - Configure Express (JSON parsing, CORS in dev, trust-proxy in prod)
//   - Request logging
//   - Mount /api routes
//   - Catch-all 404 for unmatched /api routes
//   - Serve /client/dist statically in production with SPA fallback
//   - Global error handler
//   - Listen on PORT
//
// Order of middleware matters. The current order is:
//   1. body parser
//   2. CORS (dev only)
//   3. request logger
//   4. /api/health
//   5. /api/agents and /api/debates routers
//   6. /api catch-all 404
//   7. static + SPA fallback (production only)
//   8. global error handler (must be last)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import agentsRouter from './routes/agents.js';
import debatesRouter from './routes/debates.js';
import statsRouter from './routes/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3001;
const isProduction = process.env.NODE_ENV === 'production';

const app = express();

// Trust the upstream proxy in production (Railway). This is what enables
// req.ip to use the X-Forwarded-For header set by Railway's load balancer.
// Without this, every request looks like it came from Railway's internal IP,
// breaking the rate limiter.
if (isProduction) {
  app.set('trust proxy', 1);
}

// JSON body parsing. 1mb limit is plenty for debate topics (max 500 chars per spec).
app.use(express.json({ limit: '1mb' }));

// CORS: dev only. In production the client is served same-origin, so CORS
// isn't needed and the lack of it slightly shrinks attack surface.
if (!isProduction) {
  app.use(cors());
}

// Minimal request logging: method, path, status, duration.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// API routers
app.use('/api/agents', agentsRouter);
app.use('/api/debates', debatesRouter);
app.use('/api/stats', statsRouter);

// Catch-all 404 for unmatched /api routes. Must come before the SPA fallback
// so that an unknown /api/* path returns JSON instead of the React index.html.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Static + SPA fallback (production only).
if (isProduction) {
  const clientDistPath = path.resolve(
    process.env.CLIENT_DIST_PATH ?? path.join(__dirname, '../../client/dist')
  );
  console.log(`[server] Serving static files from ${clientDistPath}`);
  app.use(express.static(clientDistPath));

  // SPA fallback: any non-/api path serves index.html so React Router can take over.
  app.get(/^(?!\/api\/).*$/, (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// Global error handler — must be last middleware registered.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  const status = err.status || 500;
  // Never leak internal error messages on 500s in production.
  const message =
    isProduction && status === 500
      ? 'Internal server error'
      : err.message || 'Internal server error';
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`[server] Listening on :${PORT} (${isProduction ? 'production' : 'development'} mode)`);
});
