// /api/debates — read endpoints + create + stream
//
// Endpoints:
//   GET  /                — paginated list (from Prompt 5)
//   GET  /:id             — full debate detail (from Prompt 5)
//   POST /                — create a new debate (keyphrase + rate limit gated)
//   GET  /:id/stream      — Server-Sent Events stream of debate events
//
// Stream semantics by debate status:
//   pending      → run the orchestrator, push events live, end on all_rounds_complete
//   in_progress  → replay saved turns, then emit an info `error` event explaining
//                  that the debate is running in another session, close
//   completed    → replay all saved state (turns + reveal) instantly, close
//   failed       → replay saved turns, emit error event, close

import { Router } from 'express';
import { requireKeyphrase } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { prisma } from '../db.js';
import { pickRandomAgents } from '../orchestrator/pickAgents.js';
import { runDebate } from '../orchestrator/runDebate.js';
import { judgeDebate } from '../judge/judgeDebate.js';

const router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'failed'];

const HEARTBEAT_INTERVAL_MS = 15_000;
const MIN_TOPIC_LENGTH = 5;
const MAX_TOPIC_LENGTH = 500;

// ============================================================================
// GET /api/debates — list (from Prompt 5, unchanged)
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
        affAgent: { select: { id: true, displayName: true } },
        negAgent: { select: { id: true, displayName: true } },
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

// ============================================================================
// GET /api/debates/:id — detail (from Prompt 5, unchanged)
// ============================================================================

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

    res.json({
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

      const { affAgent, negAgent } = await pickRandomAgents();

      const debate = await prisma.debate.create({
        data: {
          topic,
          status: 'pending',
          affAgentId: affAgent.id,
          negAgentId: negAgent.id,
        },
      });

      res.status(201).json({ debateId: debate.id });
    } catch (err) {
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

  // Switch to SSE.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/proxy buffering
  res.flushHeaders();

  const send = (eventType, payload) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(payload ?? {})}\n\n`);
  };

  // Heartbeat every 15s so proxies don't close idle connections.
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  // Abort the orchestrator if the client disconnects.
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
    // ------------------------------------------------------------------------
    // status: completed — replay everything instantly, then close.
    // ------------------------------------------------------------------------
    if (debate.status === 'completed') {
      replayCompletedDebate(send, debate);
      return finish();
    }

    // ------------------------------------------------------------------------
    // status: failed — replay turns + error, then close.
    // ------------------------------------------------------------------------
    if (debate.status === 'failed') {
      replayPartialDebate(send, debate);
      send('error', {
        message: debate.errorMessage
          ? `Debate failed: ${debate.errorMessage}`
          : 'Debate failed',
      });
      return finish();
    }

    // ------------------------------------------------------------------------
    // status: in_progress — replay saved turns, advise client, close.
    // (v1 does not support attaching mid-stream to a running debate.)
    // ------------------------------------------------------------------------
    if (debate.status === 'in_progress') {
      replayPartialDebate(send, debate);
      send('error', {
        message:
          'Debate is currently in progress in another session. Refresh in a moment to load the final result.',
      });
      return finish();
    }

    // ------------------------------------------------------------------------
    // status: pending — run the orchestrator and stream live.
    // ------------------------------------------------------------------------

    // Track which round_complete events fired so the final reveal can include them.
    // (Used by Prompts 13 and 14 when they extend this handler with judge + ELO.)
    let orchestratorDone = false;

    await runDebate({
      debateId: id,
      signal: abortController.signal,
      onEvent: (event) => {
        // Forward every orchestrator event to the SSE client by its type.
        send(event.type, event);
        if (event.type === 'all_rounds_complete') {
          orchestratorDone = true;
        }
      },
    });

    // ------------------------------------------------------------------------
    // After orchestrator: judge evaluates, then ELO updates (Prompt 14), then
    // we emit the final debate_complete reveal.
    // ------------------------------------------------------------------------
    if (orchestratorDone) {
      let evaluationResult = null;
      try {
        evaluationResult = await judgeDebate({
          debateId: id,
          signal: abortController.signal,
          onEvent: (event) => send(event.type, event),
        });
      } catch (err) {
        if (err.name === 'AbortError' || abortController.signal.aborted) throw err;
        // Judge already marked the debate failed; just surface the error.
        send('error', { message: `Judge failed: ${err.message ?? 'unknown'}` });
        return finish();
      }

      const evaluation = evaluationResult?.evaluation;

      send('debate_complete', {
        debateId: id,
        topic: debate.topic,
        affAgent: debate.affAgent,
        negAgent: debate.negAgent,
        winner: evaluation?.winner ?? null,
        evaluation: evaluation
          ? {
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
            }
          : null,
        eloChanges: [], // populated in Prompt 14
      });
    }

    finish();
  } catch (err) {
    // Orchestrator threw (or another step failed). The orchestrator marks the
    // debate as failed itself; we just emit a stream error and close.
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
  for (const t of debate.turns) {
    send('round_complete', {
      type: 'round_complete',
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
}

function replayCompletedDebate(send, debate) {
  replayPartialDebate(send, debate);
  send('all_rounds_complete', {});

  // Evaluation + ELO are populated by Prompts 13 and 14 once those modules exist.
  // For a Prompt-12-only build, debate.evaluation and debate.eloChanges may be
  // empty. We still send debate_complete with whatever's available so the
  // client can render the reveal.
  send('debate_complete', {
    debateId: debate.id,
    topic: debate.topic,
    affAgent: debate.affAgent,
    negAgent: debate.negAgent,
    winner: debate.winner,
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
        }
      : null,
    eloChanges: (debate.eloChanges || []).map((c) => ({
      agentId: c.agentId,
      before: c.before,
      after: c.after,
      delta: c.delta,
    })),
  });
}

export default router;
