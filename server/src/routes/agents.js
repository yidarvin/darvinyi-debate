// Placeholder agents router. Real read endpoints (leaderboard, profile) come
// in Prompt 5. POST endpoints don't exist for this resource — agents are
// seeded, not user-created.

import { Router } from 'express';

const router = Router();

// GET /api/agents — placeholder, returns empty array. Replaced in Prompt 5.
router.get('/', (req, res) => {
  res.json([]);
});

export default router;
