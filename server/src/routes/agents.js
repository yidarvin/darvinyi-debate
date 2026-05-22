// /api/agents — public read endpoints for agents.
//
// GET /             — leaderboard (all agents, sorted by ELO desc)
// GET /:id          — agent profile (stats + recent debates + ELO trajectory)
//
// No auth, no rate limit. Cacheable at the CDN layer if added later.

import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

const ELO_HISTORY_LIMIT = 50;
const RECENT_DEBATES_LIMIT = 20;

/**
 * GET /api/agents
 * Returns: Array<AgentSummary>
 *
 * AgentSummary = {
 *   id, displayName, provider, modelId,
 *   elo, wins, losses, draws, totalDebates,
 *   createdAt (ISO)
 * }
 */
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
 * Returns: { agent, recentDebates, eloHistory }
 *
 * recentDebates is from this agent's POV: `side` is 'aff' or 'neg' for this
 * agent, `opponent` is the other agent's {id, displayName}, and `result` is
 * 'win' | 'loss' | 'draw' from this agent's POV (not the global winner).
 *
 * eloHistory is returned in chronological order (oldest first) so the frontend
 * can render a line chart directly without reversing. Limited to the last 50
 * changes.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Recent completed debates from this agent's POV.
    const debates = await prisma.debate.findMany({
      where: {
        status: 'completed',
        OR: [{ affAgentId: id }, { negAgentId: id }],
      },
      include: {
        affAgent: { select: { id: true, displayName: true } },
        negAgent: { select: { id: true, displayName: true } },
      },
      orderBy: { completedAt: 'desc' },
      take: RECENT_DEBATES_LIMIT,
    });

    const recentDebates = debates.map((d) => {
      const isAff = d.affAgentId === id;
      const side = isAff ? 'aff' : 'neg';
      const opponent = isAff ? d.negAgent : d.affAgent;
      let result;
      if (d.winner === 'draw') result = 'draw';
      else if (d.winner === side) result = 'win';
      else result = 'loss';

      return {
        id: d.id,
        topic: d.topic,
        side,
        opponent: { id: opponent.id, displayName: opponent.displayName },
        result,
        completedAt: d.completedAt ? d.completedAt.toISOString() : null,
      };
    });

    // ELO trajectory — most recent N changes, then reversed for chronological display.
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

    // Human vote stats: how many of this agent's debates have human votes?
    // And of those, how many had the judge overridden?
    const debatesWithVotes = await prisma.debate.findMany({
      where: {
        OR: [{ affAgentId: id }, { negAgentId: id }],
        evaluation: { humanWinner: { not: null } },
      },
      include: {
        evaluation: { select: { humanAgreedWithJudge: true } },
      },
    });

    const totalHumanVotes = debatesWithVotes.length;
    const judgeOverridden = debatesWithVotes.filter(
      (d) => d.evaluation?.humanAgreedWithJudge === false,
    ).length;

    const humanVoteStats = {
      totalVotes: totalHumanVotes,
      judgeOverridden,
    };

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
      humanVoteStats,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
