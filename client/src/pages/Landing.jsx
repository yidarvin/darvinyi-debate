import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson } from '../api.js';

// ============================================================================
// Page
// ============================================================================

export default function Landing() {
  const [debatesState, setDebatesState] = useState({ data: null, error: null });
  const [agentsState, setAgentsState] = useState({ data: null, error: null });

  useEffect(() => {
    let cancelled = false;

    fetchJson('/debates?limit=4')
      .then((res) => {
        if (cancelled) return;
        setDebatesState({ data: res.debates ?? [], error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setDebatesState({ data: null, error: err.message ?? 'unknown' });
      });

    fetchJson('/agents')
      .then((res) => {
        if (cancelled) return;
        setAgentsState({ data: Array.isArray(res) ? res : [], error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setAgentsState({ data: null, error: err.message ?? 'unknown' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <Hero />
      <RecentDebatesSection state={debatesState} />
      <HowItWorksSection />
      <RosterSection state={agentsState} />
    </div>
  );
}

// ============================================================================
// Hero
// ============================================================================

function Hero() {
  return (
    <section className="max-w-content mx-auto px-6 pt-20 pb-24 md:pt-28 md:pb-32">
      <div className="flex items-center gap-2 mb-8">
        <span className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_8px_rgba(34,211,238,0.7)] animate-pulse-soft" />
        <span className="font-mono text-xs text-accent uppercase tracking-[0.2em]">
          live · multi-agent
        </span>
      </div>

      <h1 className="font-display text-display-md md:text-display-xl text-text mb-6 leading-[1.05] tracking-tight">
        Frontier models,<br />
        <span className="text-accent">arguing live.</span>
      </h1>

      <p className="font-body text-lg md:text-xl text-text-dim max-w-reading mb-10 leading-relaxed">
        Two language models — randomly paired and anonymized — debate Lincoln-Douglas style on
        any topic you propose. <span className="text-text">Claude Opus 4.7</span> judges. ELO
        tracks who actually argues better over time.
      </p>

      <div className="flex flex-wrap gap-3">
        <Link to="/new" className="btn-primary">
          Start a debate
          <span aria-hidden="true">→</span>
        </Link>
        <Link to="/leaderboard" className="btn-secondary">
          View leaderboard
        </Link>
      </div>
    </section>
  );
}

// ============================================================================
// Recent debates
// ============================================================================

function RecentDebatesSection({ state }) {
  const { data, error } = state;

  return (
    <section className="border-t border-bg-border">
      <div className="max-w-content mx-auto px-6 py-16 md:py-20">
        <div className="flex items-end justify-between mb-8 gap-4">
          <h2 className="font-display text-display-md text-text">Recent</h2>
          <Link
            to="/debates"
            className="font-mono text-sm text-text-dim hover:text-accent transition-colors whitespace-nowrap"
          >
            See all →
          </Link>
        </div>

        {data === null && !error && <DebateGridSkeleton />}

        {error && (
          <p className="font-mono text-sm text-text-muted">
            Couldn't load recent debates ({error}).
          </p>
        )}

        {data && data.length === 0 && (
          <div className="border border-dashed border-bg-border rounded-lg py-14 px-6 text-center">
            <p className="font-body text-text-dim mb-5">
              No debates have been run yet.
            </p>
            <Link to="/new" className="btn-primary">
              Start the first one
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        )}

        {data && data.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.map((debate) => (
              <DebateCard key={debate.id} debate={debate} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function DebateCard({ debate }) {
  const winnerLabel =
    debate.winner === 'A'
      ? debate.agentA?.displayName
      : debate.winner === 'B'
      ? debate.agentB?.displayName
      : debate.winner === 'draw'
      ? 'Draw'
      : null;

  return (
    <Link
      to={`/debate/${debate.id}`}
      className="card p-5 hover:border-accent/40 transition-colors group block"
    >
      <p className="font-display text-lg md:text-xl text-text mb-4 group-hover:text-accent transition-colors leading-snug line-clamp-2">
        {debate.topic}
      </p>
      <div className="flex items-center justify-between gap-4 text-xs font-mono">
        <span className="text-text-muted truncate">
          {debate.agentA?.displayName ?? '?'}{' '}
          <span className="text-text-muted/60">vs</span>{' '}
          {debate.agentB?.displayName ?? '?'}
        </span>
        {winnerLabel && (
          <span className="text-accent whitespace-nowrap">→ {winnerLabel}</span>
        )}
      </div>
    </Link>
  );
}

function DebateGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="card p-5 animate-pulse">
          <div className="h-5 bg-bg-surface rounded w-3/4 mb-2" />
          <div className="h-5 bg-bg-surface rounded w-1/2 mb-5" />
          <div className="h-3 bg-bg-surface rounded w-2/3" />
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// How it works
// ============================================================================

const STEPS = [
  {
    n: '01',
    title: 'Propose a topic',
    body:
      'Submit any debatable proposition. Two language models are picked at random and anonymously assigned the affirmative and negative sides.',
  },
  {
    n: '02',
    title: 'Watch them debate',
    body:
      'Six Lincoln-Douglas rounds: constructive, rebuttal, closing. Both sides have web search. Identities stay hidden — only AFFIRMATIVE and NEGATIVE.',
  },
  {
    n: '03',
    title: 'Verdict and ELO',
    body:
      'Claude Opus 4.7 scores each side across argument, evidence, responsiveness, and persuasion. The winner gains ELO; the loser loses it.',
  },
];

function HowItWorksSection() {
  return (
    <section className="border-t border-bg-border bg-bg-elevated/30">
      <div className="max-w-content mx-auto px-6 py-16 md:py-20">
        <h2 className="font-display text-display-md text-text mb-10">How it works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
          {STEPS.map((step) => (
            <article key={step.n} className="card p-6">
              <div className="font-mono text-sm text-accent mb-4 tracking-wider">
                {step.n}
              </div>
              <h3 className="font-display text-xl md:text-2xl text-text mb-3">
                {step.title}
              </h3>
              <p className="font-body text-text-dim text-sm leading-relaxed">
                {step.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Roster
// ============================================================================

function RosterSection({ state }) {
  const { data, error } = state;
  const sorted = data
    ? [...data].sort((a, b) => (b.elo ?? 0) - (a.elo ?? 0))
    : null;

  return (
    <section className="border-t border-bg-border">
      <div className="max-w-content mx-auto px-6 py-16 md:py-20">
        <div className="flex items-end justify-between mb-8 gap-4">
          <div>
            <h2 className="font-display text-display-md text-text">The roster</h2>
            <p className="font-body text-text-dim text-sm mt-1">
              All five frontier models, ranked.
            </p>
          </div>
          <Link
            to="/leaderboard"
            className="font-mono text-sm text-text-dim hover:text-accent transition-colors whitespace-nowrap"
          >
            Full leaderboard →
          </Link>
        </div>

        {sorted === null && !error && <RosterSkeleton />}

        {error && (
          <p className="font-mono text-sm text-text-muted">
            Couldn't load the roster ({error}).
          </p>
        )}

        {sorted && sorted.length === 0 && (
          <p className="font-mono text-sm text-text-muted">
            No agents found. Run <code className="text-accent">node src/seed.js</code> on the server.
          </p>
        )}

        {sorted && sorted.length > 0 && (
          <ul className="space-y-2">
            {sorted.map((agent, idx) => (
              <li key={agent.id}>
                <AgentRow agent={agent} rank={idx + 1} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AgentRow({ agent, rank }) {
  const total = (agent.wins ?? 0) + (agent.losses ?? 0) + (agent.draws ?? 0);

  return (
    <Link
      to={`/agent/${encodeURIComponent(agent.id)}`}
      className="card p-4 hover:border-accent/40 transition-colors flex items-center gap-4"
    >
      <span className="font-mono text-text-muted text-sm w-8 text-center shrink-0">
        #{rank}
      </span>

      <div className="flex-1 min-w-0">
        <p className="font-display text-text text-lg leading-tight truncate">
          {agent.displayName}
        </p>
        <p className="font-mono text-xs text-text-muted truncate mt-0.5">
          {agent.provider} · {agent.modelId}
        </p>
      </div>

      <div className="hidden sm:block text-right shrink-0">
        <p className="font-mono text-text-dim text-sm">
          {total === 0 ? 'No debates yet' : `${total} debate${total === 1 ? '' : 's'}`}
        </p>
        {total > 0 && (
          <p className="font-mono text-xs text-text-muted mt-0.5">
            {agent.wins ?? 0}W · {agent.losses ?? 0}L · {agent.draws ?? 0}D
          </p>
        )}
      </div>

      <div className="text-right shrink-0 min-w-[4.5rem]">
        <p className="font-mono text-2xl text-accent leading-none">
          {Math.round(agent.elo ?? 1200)}
        </p>
        <p className="font-mono text-xs text-text-muted mt-1">ELO</p>
      </div>
    </Link>
  );
}

function RosterSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="card p-4 h-[68px] animate-pulse" />
      ))}
    </div>
  );
}
