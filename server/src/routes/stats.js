// Aggregate stats endpoints. Mounted at /api/stats.

import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

// ============================================================================
// GET /api/stats/judge
// Returns site-wide judge agreement stats based on Evaluation.humanAgreedWithJudge.
// ============================================================================

router.get('/judge', async (_req, res, next) => {
  try {
    const evaluations = await prisma.evaluation.findMany({
      where: { humanWinner: { not: null } },
      select: { humanAgreedWithJudge: true },
    });

    const totalVotes = evaluations.length;
    const agreedVotes = evaluations.filter((e) => e.humanAgreedWithJudge === true).length;
    const overriddenVotes = evaluations.filter((e) => e.humanAgreedWithJudge === false).length;
    const agreementRate = totalVotes > 0 ? agreedVotes / totalVotes : null;

    res.json({
      totalVotes,
      agreedVotes,
      overriddenVotes,
      agreementRate,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
