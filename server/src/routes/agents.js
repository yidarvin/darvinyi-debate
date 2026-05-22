// /api/agents — public read endpoints for agents.
//
// GET /             — leaderboard (all agents, sorted by ELO desc)
// GET /:id          — agent profile (stats + recent matches + ELO trajectory)
//
// No auth, no rate limit. Cacheable at the CDN layer if added later.
//
// Recent debates and ELO history are per-MATCH, not per-leg. The match-level
// outcome ('A' | 'B' | 'draw' on Debate.winner) drives the win/loss/draw labels.

import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

const ELO_HISTORY_LIMIT = 50;
const RECENT_DEBATES_LIMIT = 20;

router.get('/', async (req, res, next) => {
  try {
    const agents = await prisma.agent.findMany({
      orderBy: [{ elo: 'desc' }, { displayName: 'asc' }],
    });

    res.json(
      agents.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        provider: a.provider,
        modelId: a.modelId,
        elo: a.elo,
        wins: a.wins,
        losses: a.losses,
        draws: a.draws,
        totalDebates: a.wins + a.losses + a.draws,
        createdAt: a.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/agents/:id
 * Returns: { agent, recentDebates, eloHistory, humanVoteStats }
 *
 * recentDebates: one row per match this agent participated in. role is 'A' or 'B'
 * (which side of the match they were assigned), opponent is the other agent,
 * result is 'win' | 'loss' | 'draw' derived from debate.winner.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const debates = await prisma.debate.findMany({
      where: {
        status: 'completed',
        OR: [{ agentAId: id }, { agentBId: id }],
      },
      include: {
        agentA: { select: { id: true, displayName: true } },
        agentB: { select: { id: true, displayName: true } },
        evaluations: { select: { humanAgreedWithJudge: true, humanWinner: true } },
        eloChanges: { where: { agentId: id }, select: { before: true, after: true, delta: true } },
      },
      orderBy: { completedAt: 'desc' },
      take: RECENT_DEBATES_LIMIT,
    });

    const recentDebates = debates.map((d) => {
      const isA = d.agentAId === id;
      const role = isA ? 'A' : 'B';
      const opponent = isA ? d.agentB : d.agentA;
      let result;
      if (d.winner === 'draw') result = 'draw';
      else if (d.winner === role) result = 'win';
      else result = 'loss';

      const eloChange = d.eloChanges[0] ?? null;

      return {
        id: d.id,
        topic: d.topic,
        role,
        opponent: { id: opponent.id, displayName: opponent.displayName },
        result,
        completedAt: d.completedAt ? d.completedAt.toISOString() : null,
        elo: eloChange
          ? { before: eloChange.before, after: eloChange.after, delta: eloChange.delta }
          : null,
      };
    });

    // ELO trajectory — one entry per match (debate). Sorted oldest first for charting.
    const recentChanges = await prisma.eloChange.findMany({
      where: { agentId: id },
      orderBy: { createdAt: 'desc' },
      take: ELO_HISTORY_LIMIT,
    });
    const eloHistory = recentChanges
      .reverse()
      .map((c) => ({
        debateId: c.debateId,
        before: c.before,
        after: c.after,
        delta: c.delta,
        createdAt: c.createdAt.toISOString(),
      }));

    // Human vote stats: count of MATCHES this agent participated in where at
    // least one leg has a human vote, and how many of those had at least one
    // leg's humanAgreedWithJudge === false.
    const debatesWithVotes = await prisma.debate.findMany({
      where: {
        OR: [{ agentAId: id }, { agentBId: id }],
        evaluations: { some: { humanWinner: { not: null } } },
      },
      include: {
        evaluations: {
          where: { humanWinner: { not: null } },
          select: { humanAgreedWithJudge: true },
        },
      },
    });

    const totalHumanVotes = debatesWithVotes.length;
    const judgeOverridden = debatesWithVotes.filter((d) =>
      d.evaluations.some((e) => e.humanAgreedWithJudge === false),
    ).length;

    res.json({
      agent: {
        id: agent.id,
        displayName: agent.displayName,
        provider: agent.provider,
        modelId: agent.modelId,
        elo: agent.elo,
        wins: agent.wins,
        losses: agent.losses,
        draws: agent.draws,
        totalDebates: agent.wins + agent.losses + agent.draws,
        createdAt: agent.createdAt.toISOString(),
      },
      recentDebates,
      eloHistory,
      humanVoteStats: {
        totalVotes: totalHumanVotes,
        judgeOverridden,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
