// Placeholder debates router.
//
// GET / and GET /:id are placeholders — real handlers come in Prompt 5.
// POST / is wired through the real auth + rate limit middleware so we can
// verify the full request path end-to-end before the orchestrator (Prompt 12)
// fills in the body.

import { Router } from 'express';
import { requireKeyphrase } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// GET /api/debates — placeholder, returns empty pagination shape. Replaced in Prompt 5.
router.get('/', (req, res) => {
  res.json({ debates: [], nextCursor: null });
});

// GET /api/debates/:id — placeholder. Replaced in Prompt 5.
router.get('/:id', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// POST /api/debates — keyphrase + per-IP rate limit gated.
// Body and behavior implemented in Prompt 12; this handler exists to verify
// the auth + rate limit chain works.
router.post(
  '/',
  requireKeyphrase,
  rateLimit({ max: 3, windowMs: 24 * 60 * 60 * 1000 }),
  (req, res) => {
    res.status(501).json({ error: 'Not implemented yet' });
  }
);

export default router;
