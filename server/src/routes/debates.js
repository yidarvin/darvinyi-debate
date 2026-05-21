// /api/debates — public read endpoints plus the POST placeholder (real
// implementation in Prompt 12; keyphrase + rate-limit gating is wired here).
//
// GET /               — paginated list of debates
// GET /:id            — full debate detail (turns, evaluation, ELO changes)
// POST /              — placeholder (501) behind auth + rate limit
//
// Cursor pagination via ?before=<ISO completedAt>. Default page size 20,
// max 100. By default only `completed` debates are returned; pass
// ?status=all to include all statuses, or ?status=in_progress for a specific
// one.

import { Router } from 'express';
import { requireKeyphrase } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { prisma } from '../db.js';

const router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'failed'];

/**
 * GET /api/debates
 * Query params:
 *   limit  — number, default 20, max 100
 *   before — ISO datetime; returns debates with completedAt < this value
 *   status — one of {pending, in_progress, completed, failed, all}; default 'completed'
 *
 * Returns: { debates: Array<DebateSummary>, nextCursor: ISO | null }
 *
 * DebateSummary = {
 *   id, topic, status, winner,
 *   affAgent: { id, displayName },
 *   negAgent: { id, displayName },
 *   createdAt (ISO), completedAt (ISO | null)
 * }
 */
router.get('/', async (req, res, next) => {
  try {
    // Parse limit
    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const parsed = Number.parseInt(req.query.limit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    // Parse before
    let beforeDate = null;
    if (req.query.before !== undefined) {
      const d = new Date(req.query.before);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'before must be an ISO 8601 datetime' });
      }
      beforeDate = d;
    }

    // Parse status
    const statusParam = req.query.status;
    const where = {};
    if (statusParam === 'all') {
      // no status filter
    } else if (statusParam !== undefined) {
      if (!VALID_STATUSES.includes(statusParam)) {
        return res.status(400).json({
          error: `status must be one of: ${VALID_STATUSES.join(', ')}, or 'all'`,
        });
      }
      where.status = statusParam;
    } else {
      where.status = 'completed';
    }

    if (beforeDate) {
      where.completedAt = { lt: beforeDate };
    }

    const debates = await prisma.debate.findMany({
      where,
      include: {
        affAgent: { select: { id: true, displayName: true } },
        negAgent: { select: { id: true, displayName: true } },
      },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

    // nextCursor only set if we returned a full page and the last row has a
    // completedAt (debates without completedAt can't be used as cursors).
    let nextCursor = null;
    if (debates.length === limit) {
      const last = debates[debates.length - 1];
      if (last.completedAt) {
        nextCursor = last.completedAt.toISOString();
      }
    }

    res.json({
      debates: debates.map((d) => ({
        id: d.id,
        topic: d.topic,
        status: d.status,
        winner: d.winner,
        affAgent: d.affAgent,
        negAgent: d.negAgent,
        createdAt: d.createdAt.toISOString(),
        completedAt: d.completedAt ? d.completedAt.toISOString() : null,
      })),
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/debates/:id
 * Returns: { debate, turns, evaluation, eloChanges }
 *
 * Scores in evaluation are renamed for the API: Prisma `affResponsive` becomes
 * `responsive` under `affScores`, and `affPersuasion` becomes `persuasion`,
 * etc. This keeps the API consistent with the frontend usage.
 *
 * `errorMessage` is NEVER returned in this response (may contain internal
 * info on failed debates).
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const debate = await prisma.debate.findUnique({
      where: { id },
      include: {
        affAgent: { select: { id: true, displayName: true, provider: true, modelId: true } },
        negAgent: { select: { id: true, displayName: true, provider: true, modelId: true } },
        turns: { orderBy: { roundNumber: 'asc' } },
        evaluation: true,
        eloChanges: true,
      },
    });

    if (!debate) {
      return res.status(404).json({ error: 'Debate not found' });
    }

    const response = {
      debate: {
        id: debate.id,
        topic: debate.topic,
        status: debate.status,
        winner: debate.winner,
        createdAt: debate.createdAt.toISOString(),
        completedAt: debate.completedAt ? debate.completedAt.toISOString() : null,
        affAgent: debate.affAgent,
        negAgent: debate.negAgent,
      },
      turns: debate.turns.map((t) => ({
        roundNumber: t.roundNumber,
        roundName: t.roundName,
        side: t.side,
        content: t.content,
        toolCalls: t.toolCalls,
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut,
        durationMs: t.durationMs,
        createdAt: t.createdAt.toISOString(),
      })),
      evaluation: debate.evaluation
        ? {
            winner: debate.evaluation.winner,
            affScores: {
              argument: debate.evaluation.affArgument,
              evidence: debate.evaluation.affEvidence,
              responsive: debate.evaluation.affResponsive,
              persuasion: debate.evaluation.affPersuasion,
              total: debate.evaluation.affTotal,
            },
            negScores: {
              argument: debate.evaluation.negArgument,
              evidence: debate.evaluation.negEvidence,
              responsive: debate.evaluation.negResponsive,
              persuasion: debate.evaluation.negPersuasion,
              total: debate.evaluation.negTotal,
            },
            reasoning: debate.evaluation.reasoning,
            judgeModel: debate.evaluation.judgeModel,
            createdAt: debate.evaluation.createdAt.toISOString(),
          }
        : null,
      eloChanges: debate.eloChanges.map((c) => ({
        agentId: c.agentId,
        before: c.before,
        after: c.after,
        delta: c.delta,
      })),
    };

    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/debates — placeholder.
 * Auth + rate limit are wired here so the full request path can be tested
 * before the orchestrator is implemented in Prompt 12.
 */
router.post(
  '/',
  requireKeyphrase,
  rateLimit({ max: 3, windowMs: 24 * 60 * 60 * 1000 }),
  (req, res) => {
    res.status(501).json({ error: 'Not implemented yet' });
  },
);

export default router;
