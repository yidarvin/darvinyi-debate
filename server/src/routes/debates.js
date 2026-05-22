// /api/debates — read endpoints + create + stream
//
// Endpoints:
//   GET  /                — paginated list
//   GET  /:id             — full debate detail (two legs, two evaluations)
//   POST /                — create a new debate (keyphrase + rate limit gated)
//   POST /:id/vote        — record per-leg human vote (agreement only)
//   GET  /:id/stream      — Server-Sent Events stream of debate events
//
// Stream semantics by debate status:
//   pending      → run the orchestrator (two legs), then judge each leg, then ELO, close
//   in_progress  → replay saved turns, advise client, close
//   judging      → replay saved turns + any saved evaluations, advise client, close
//   completed    → replay all saved state instantly, close
//   failed       → replay saved turns + evaluations + error, close

import { Router } from 'express';
import { requireKeyphrase } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { prisma } from '../db.js';
import { pickRandomAgents } from '../orchestrator/pickAgents.js';
import { runDebate } from '../orchestrator/runDebate.js';
import { judgeLeg } from '../judge/judgeDebate.js';
import { applyEloChange } from '../elo/applyEloChange.js';
import { recordHumanVote } from '../elo/applyHumanVote.js';
import { computeMatchOutcome } from '../match/computeMatchOutcome.js';

const router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const VALID_STATUSES = ['pending', 'in_progress', 'judging', 'completed', 'failed'];

const HEARTBEAT_INTERVAL_MS = 15_000;
const MIN_TOPIC_LENGTH = 5;
const MAX_TOPIC_LENGTH = 500;

// ============================================================================
// Serialization helpers
// ============================================================================

function serializeEvaluation(evaluation) {
  if (!evaluation) return null;
  return {
    leg: evaluation.leg,
    winner: evaluation.winner,
    affScores: {
      argument: evaluation.affArgument,
      evidence: evaluation.affEvidence,
      responsive: evaluation.affResponsive,
      persuasion: evaluation.affPersuasion,
      total: evaluation.affTotal,
    },
    negScores: {
      argument: evaluation.negArgument,
      evidence: evaluation.negEvidence,
      responsive: evaluation.negResponsive,
      persuasion: evaluation.negPersuasion,
      total: evaluation.negTotal,
    },
    reasoning: evaluation.reasoning,
    judgeModel: evaluation.judgeModel,
    humanWinner: evaluation.humanWinner,
    humanVotedAt: evaluation.humanVotedAt ? evaluation.humanVotedAt.toISOString() : null,
    humanAgreedWithJudge: evaluation.humanAgreedWithJudge,
    createdAt: evaluation.createdAt ? evaluation.createdAt.toISOString() : null,
  };
}

function serializeTurn(t) {
  return {
    leg: t.leg,
    roundNumber: t.roundNumber,
    roundName: t.roundName,
    side: t.side,
    content: t.content,
    toolCalls: t.toolCalls ?? [],
    tokensIn: t.tokensIn ?? 0,
    tokensOut: t.tokensOut ?? 0,
    durationMs: t.durationMs ?? 0,
    createdAt: t.createdAt ? t.createdAt.toISOString() : null,
  };
}

// ============================================================================
// GET /api/debates — list
// ============================================================================

router.get('/', async (req, res, next) => {
  try {
    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const parsed = Number.parseInt(req.query.limit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    let beforeDate = null;
    if (req.query.before !== undefined) {
      const d = new Date(req.query.before);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'before must be an ISO 8601 datetime' });
      }
      beforeDate = d;
    }

    const statusParam = req.query.status;
    const where = {};
    if (statusParam === 'all') {
      // no filter
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
        agentA: { select: { id: true, displayName: true } },
        agentB: { select: { id: true, displayName: true } },
      },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

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
        agentA: d.agentA,
        agentB: d.agentB,
        createdAt: d.createdAt.toISOString(),
        completedAt: d.completedAt ? d.completedAt.toISOString() : null,
      })),
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/debates/:id — detail
// ============================================================================

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const debate = await prisma.debate.findUnique({
      where: { id },
      include: {
        agentA: { select: { id: true, displayName: true, provider: true, modelId: true } },
        agentB: { select: { id: true, displayName: true, provider: true, modelId: true } },
        turns: { orderBy: [{ leg: 'asc' }, { roundNumber: 'asc' }] },
        evaluations: { orderBy: { leg: 'asc' } },
        eloChanges: true,
      },
    });

    if (!debate) {
      return res.status(404).json({ error: 'Debate not found' });
    }

    const [eval1, eval2] = debate.evaluations;
    const matchOutcome =
      eval1 && eval2 ? computeMatchOutcome({ eval1, eval2 }) : null;

    res.json({
      debate: {
        id: debate.id,
        topic: debate.topic,
        status: debate.status,
        winner: debate.winner,
        createdAt: debate.createdAt.toISOString(),
        completedAt: debate.completedAt ? debate.completedAt.toISOString() : null,
        agentA: debate.agentA,
        agentB: debate.agentB,
      },
      turns: debate.turns.map(serializeTurn),
      evaluations: debate.evaluations.map(serializeEvaluation),
      matchOutcome,
      eloChanges: debate.eloChanges.map((c) => ({
        agentId: c.agentId,
        before: c.before,
        after: c.after,
        delta: c.delta,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// POST /api/debates — create a new debate
// ============================================================================

router.post(
  '/',
  requireKeyphrase,
  rateLimit({ max: 3, windowMs: 24 * 60 * 60 * 1000 }),
  async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const rawTopic = body.topic;
      const rerunOf = body.rerunOf;

      let topic;

      if (rerunOf !== undefined && rerunOf !== null && rerunOf !== '') {
        if (typeof rerunOf !== 'string') {
          return res.status(400).json({ error: 'rerunOf must be a string debate id' });
        }
        const source = await prisma.debate.findUnique({
          where: { id: rerunOf },
          select: { topic: true },
        });
        if (!source) {
          return res.status(404).json({ error: 'Source debate for rerun not found' });
        }
        topic = source.topic;
      } else {
        if (typeof rawTopic !== 'string') {
          return res.status(400).json({ error: 'topic is required and must be a string' });
        }
        topic = rawTopic.trim();
        if (topic.length < MIN_TOPIC_LENGTH) {
          return res.status(400).json({ error: `topic must be at least ${MIN_TOPIC_LENGTH} characters` });
        }
        if (topic.length > MAX_TOPIC_LENGTH) {
          return res.status(400).json({ error: `topic must be at most ${MAX_TOPIC_LENGTH} characters` });
        }
      }

      const { agentA, agentB } = await pickRandomAgents();

      const debate = await prisma.debate.create({
        data: {
          topic,
          status: 'pending',
          agentAId: agentA.id,
          agentBId: agentB.id,
        },
      });

      res.status(201).json({ debateId: debate.id });
    } catch (err) {
      next(err);
    }
  },
);

// ============================================================================
// POST /api/debates/:id/vote — per-leg human agreement vote
// ============================================================================

router.post(
  '/:id/vote',
  requireKeyphrase,
  rateLimit({ max: 50, windowMs: 24 * 60 * 60 * 1000 }),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { leg, winner } = req.body ?? {};

      if (leg !== 1 && leg !== 2) {
        return res.status(400).json({ error: 'leg must be 1 or 2' });
      }
      if (!['aff', 'neg', 'draw'].includes(winner)) {
        return res.status(400).json({ error: "winner must be 'aff', 'neg', or 'draw'" });
      }

      const result = await recordHumanVote(id, leg, winner);
      res.json(result);
    } catch (err) {
      const msg = err?.message ?? '';

      if (msg.includes('No evaluation found')) {
        return res.status(404).json({ error: msg });
      }
      if (msg.includes('already has a human vote') || msg.includes('already recorded')) {
        return res.status(409).json({ error: msg });
      }
      if (
        msg.includes('leg must be') ||
        msg.includes("must be 'aff'") ||
        msg.includes('humanWinner must be')
      ) {
        return res.status(400).json({ error: msg });
      }

      next(err);
    }
  },
);

// ============================================================================
// GET /api/debates/:id/stream — SSE
// ============================================================================

router.get('/:id/stream', async (req, res) => {
  const { id } = req.params;

  // Pre-flight: confirm debate exists. Done as a JSON 404 BEFORE switching to SSE.
  const debate = await prisma.debate.findUnique({
    where: { id },
    include: {
      agentA: { select: { id: true, displayName: true, provider: true, modelId: true } },
      agentB: { select: { id: true, displayName: true, provider: true, modelId: true } },
      turns: { orderBy: [{ leg: 'asc' }, { roundNumber: 'asc' }] },
      evaluations: { orderBy: { leg: 'asc' } },
      eloChanges: true,
    },
  });

  if (!debate) {
    return res.status(404).json({ error: 'Debate not found' });
  }

  // Switch to SSE.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (eventType, payload) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(payload ?? {})}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const abortController = new AbortController();
  req.on('close', () => {
    clearInterval(heartbeat);
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  });

  const finish = () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };

  try {
    if (debate.status === 'completed') {
      replayCompletedDebate(send, debate);
      return finish();
    }

    if (debate.status === 'failed') {
      replayPartialDebate(send, debate);
      send('error', {
        message: debate.errorMessage
          ? `Debate failed: ${debate.errorMessage}`
          : 'Debate failed',
      });
      return finish();
    }

    if (debate.status === 'in_progress' || debate.status === 'judging') {
      replayPartialDebate(send, debate);
      send('error', {
        message:
          'Debate is currently running in another session. Refresh in a moment to load the final result.',
      });
      return finish();
    }

    // ------------------------------------------------------------------------
    // status: pending — run orchestrator (two legs), then judge each leg, then ELO.
    // ------------------------------------------------------------------------

    let orchestratorDone = false;

    await runDebate({
      debateId: id,
      signal: abortController.signal,
      onEvent: (event) => {
        send(event.type, event);
        if (event.type === 'all_legs_complete') {
          orchestratorDone = true;
        }
      },
    });

    if (!orchestratorDone) {
      // Orchestrator returned without emitting all_legs_complete — shouldn't happen, but bail out cleanly.
      return finish();
    }

    // Transition to 'judging' before invoking the judge.
    await prisma.debate.update({
      where: { id },
      data: { status: 'judging' },
    });

    try {
      await judgeLeg({
        debateId: id,
        leg: 1,
        signal: abortController.signal,
        onEvent: (event) => send(event.type, event),
      });
      await judgeLeg({
        debateId: id,
        leg: 2,
        signal: abortController.signal,
        onEvent: (event) => send(event.type, event),
      });
    } catch (err) {
      if (err.name === 'AbortError' || abortController.signal.aborted) throw err;
      send('error', { message: `Judge failed: ${err.message}` });
      return finish();
    }

    let eloResult = null;
    try {
      eloResult = await applyEloChange(id);
    } catch (err) {
      console.error('[stream] applyEloChange failed for', id, ':', err);
      send('error', {
        message: `ELO update failed: ${err.message} (verdicts stand; leaderboard may be temporarily out of sync)`,
      });
    }

    if (eloResult) {
      send('elo_updated', { changes: eloResult.eloChanges });
    }

    const finalDebate = await prisma.debate.findUnique({
      where: { id },
      include: {
        agentA: true,
        agentB: true,
        evaluations: { orderBy: { leg: 'asc' } },
        eloChanges: true,
      },
    });

    send('debate_complete', {
      debateId: id,
      topic: finalDebate.topic,
      agentA: finalDebate.agentA,
      agentB: finalDebate.agentB,
      winner: finalDebate.winner,
      evaluations: finalDebate.evaluations.map(serializeEvaluation),
      matchOutcome: eloResult?.outcome ?? null,
      eloChanges: finalDebate.eloChanges.map((c) => ({
        agentId: c.agentId,
        before: c.before,
        after: c.after,
        delta: c.delta,
      })),
    });

    finish();
  } catch (err) {
    if (!res.writableEnded) {
      const msg = err?.name === 'AbortError' ? 'Connection aborted' : `Stream error: ${err?.message ?? 'unknown'}`;
      send('error', { message: msg });
    }
    finish();
  }
});

// ============================================================================
// Replay helpers
// ============================================================================

function replayPartialDebate(send, debate) {
  send('debate_start', { debateId: debate.id, topic: debate.topic });

  // Walk turns grouped by leg, emitting leg_start / round_complete / leg_complete.
  const byLeg = new Map();
  for (const t of debate.turns) {
    if (!byLeg.has(t.leg)) byLeg.set(t.leg, []);
    byLeg.get(t.leg).push(t);
  }

  const legNumbers = [...byLeg.keys()].sort((a, b) => a - b);
  for (const leg of legNumbers) {
    send('leg_start', { leg });
    const turns = byLeg.get(leg);
    for (const t of turns) {
      send('round_complete', {
        leg: t.leg,
        round: t.roundNumber,
        side: t.side,
        content: t.content,
        toolCalls: t.toolCalls ?? [],
        tokensIn: t.tokensIn ?? 0,
        tokensOut: t.tokensOut ?? 0,
        durationMs: t.durationMs ?? 0,
        resumed: true,
      });
    }
    // Only emit leg_complete if the leg has all 6 turns saved.
    if (turns.length === 6) {
      send('leg_complete', { leg });
    }
  }

  // Replay any saved evaluations.
  for (const evaluation of debate.evaluations) {
    send('evaluation_complete', {
      leg: evaluation.leg,
      winner: evaluation.winner,
      affScores: {
        argument: evaluation.affArgument,
        evidence: evaluation.affEvidence,
        responsive: evaluation.affResponsive,
        persuasion: evaluation.affPersuasion,
        total: evaluation.affTotal,
      },
      negScores: {
        argument: evaluation.negArgument,
        evidence: evaluation.negEvidence,
        responsive: evaluation.negResponsive,
        persuasion: evaluation.negPersuasion,
        total: evaluation.negTotal,
      },
      reasoning: evaluation.reasoning,
      judgeModel: evaluation.judgeModel,
    });
  }
}

function replayCompletedDebate(send, debate) {
  replayPartialDebate(send, debate);
  send('all_legs_complete', {});

  const [eval1, eval2] = debate.evaluations;
  const matchOutcome =
    eval1 && eval2 ? computeMatchOutcome({ eval1, eval2 }) : null;

  const eloChangesPayload = (debate.eloChanges || []).map((c) => ({
    agentId: c.agentId,
    before: c.before,
    after: c.after,
    delta: c.delta,
  }));

  if (eloChangesPayload.length > 0) {
    send('elo_updated', { changes: eloChangesPayload });
  }

  send('debate_complete', {
    debateId: debate.id,
    topic: debate.topic,
    agentA: debate.agentA,
    agentB: debate.agentB,
    winner: debate.winner,
    evaluations: debate.evaluations.map(serializeEvaluation),
    matchOutcome,
    eloChanges: eloChangesPayload,
  });
}

export default router;
