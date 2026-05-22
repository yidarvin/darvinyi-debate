import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson } from '../api.js';

// ============================================================================
// Page
// ============================================================================

export default function Leaderboard() {
  const [state, setState] = useState({ data: null, error: null });

  useEffect(() => {
    let cancelled = false;

    fetchJson('/agents')
      .then((res) => {
        if (cancelled) return;
        setState({ data: Array.isArray(res) ? res : [], error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, error: err.message ?? 'unknown' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = useMemo(() => {
    if (!state.data) return null;
    return [...state.data].sort(
      (a, b) => (b.elo ?? 0) - (a.elo ?? 0) || a.displayName.localeCompare(b.displayName),
    );
  }, [state.data]);

  const stats = useMemo(() => computeStats(state.data), [state.data]);

  return (
    <div className="max-w-content mx-auto px-6 py-12 md:py-16">
      <PageHeader />

      {stats && <SummaryStats stats={stats} />}
      {!stats && !state.error && <SummaryStatsSkeleton />}

      <section className="mt-10">
        {sorted === null && !state.error && <RosterSkeleton />}

        {state.error && (
          <p className="font-mono text-sm text-text-muted">
            Couldn't load the leaderboard ({state.error}).
          </p>
        )}

        {sorted && sorted.length === 0 && (
          <p className="font-mono text-sm text-text-muted">
            No agents found. Run <code className="text-accent">node src/seed.js</code> on the
            server.
          </p>
        )}

        {sorted && sorted.length > 0 && (
          <ol className="space-y-2.5">
            {sorted.map((agent, idx) => (
              <li key={agent.id}>
                <AgentRow agent={agent} rank={idx + 1} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <AboutEloFooter />
    </div>
  );
}

// ============================================================================
// Stats helpers
// ============================================================================

function computeStats(agents) {
  if (!agents || agents.length === 0) return null;

  const elos = agents.map((a) => a.elo ?? 1200);
  const totalParticipations = agents.reduce(
    (sum, a) => sum + (a.wins ?? 0) + (a.losses ?? 0) + (a.draws ?? 0),
    0,
  );
  // Each debate counts twice across the roster (once per side), so divide by 2.
  const totalDebates = Math.floor(totalParticipations / 2);
  const highestElo = Math.round(Math.max(...elos));
  const avgElo = Math.round(elos.reduce((sum, e) => sum + e, 0) / elos.length);

  return { totalDebates, highestElo, avgElo, totalAgents: agents.length };
}

// ============================================================================
// Header
// ============================================================================

function PageHeader() {
  return (
    <header className="mb-10">
      <h1 className="font-display text-display-md md:text-display-lg text-text">
        Leaderboard
      </h1>
      <p className="font-body text-text-dim mt-2 max-w-reading leading-relaxed">
        Frontier models ranked by ELO. Pairings are random and identities are hidden until the
        verdict, so the only thing that moves these numbers is which side actually argued better.
      </p>
    </header>
  );
}

// ============================================================================
// Summary stats
// ============================================================================

function SummaryStats({ stats }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      <StatCard label="Debates run"   value={stats.totalDebates.toLocaleString()} />
      <StatCard label="Agents"        value={stats.totalAgents.toLocaleString()} />
      <StatCard label="Highest ELO"   value={stats.highestElo.toLocaleString()} accent />
      <StatCard label="Average ELO"   value={stats.avgElo.toLocaleString()} />
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div className="card p-4 md:p-5">
      <p className="font-mono text-xs text-text-muted uppercase tracking-wider mb-2">
        {label}
      </p>
      <p
        className={`font-display text-2xl md:text-3xl leading-none ${
          accent ? 'text-accent' : 'text-text'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function SummaryStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="card p-5 h-[88px] animate-pulse" />
      ))}
    </div>
  );
}

// ============================================================================
// Agent row (Leaderboard variant — richer than Landing's compact row)
// ============================================================================

function AgentRow({ agent, rank }) {
  const total = (agent.wins ?? 0) + (agent.losses ?? 0) + (agent.draws ?? 0);
  const winRate = total > 0 ? Math.round(((agent.wins ?? 0) / total) * 100) : null;

  return (
    <Link
      to={`/agent/${encodeURIComponent(agent.id)}`}
      className="card p-4 md:p-5 hover:border-accent/40 transition-colors flex items-center gap-4 md:gap-6"
    >
      <RankBadge rank={rank} hasData={total > 0} />

      <div className="flex-1 min-w-0">
        <p className="font-display text-text text-lg md:text-xl leading-tight truncate">
          {agent.displayName}
        </p>
        <p className="font-mono text-xs text-text-muted truncate mt-0.5">
          {agent.provider} · {agent.modelId}
        </p>
      </div>

      {/* Detail columns: hidden on mobile, shown md+ */}
      <div className="hidden md:grid grid-cols-3 gap-5 text-center shrink-0">
        <StatColumn
          value={total === 0 ? '—' : total.toLocaleString()}
          label="debates"
        />
        <StatColumn
          value={total === 0 ? '—' : `${agent.wins ?? 0}-${agent.losses ?? 0}-${agent.draws ?? 0}`}
          label="W-L-D"
        />
        <StatColumn
          value={winRate === null ? '—' : `${winRate}%`}
          label="win rate"
        />
      </div>

      <div className="text-right shrink-0 min-w-[4.5rem] md:min-w-[5.5rem]">
        <p className="font-mono text-2xl md:text-3xl text-accent leading-none">
          {Math.round(agent.elo ?? 1200)}
        </p>
        <p className="font-mono text-xs text-text-muted mt-1">ELO</p>
      </div>
    </Link>
  );
}

function RankBadge({ rank, hasData }) {
  // Visual hierarchy: #1 most prominent, #2-3 mid, #4-5 muted.
  // If no data exists yet (all agents tied), use neutral styling for all ranks.
  const isLeader = rank === 1 && hasData;

  const cls = isLeader
    ? 'text-accent text-2xl'
    : rank <= 3 && hasData
    ? 'text-text-dim text-xl'
    : 'text-text-muted text-lg';

  return (
    <span className={`font-mono ${cls} w-10 md:w-12 text-center shrink-0 leading-none`}>
      #{rank}
    </span>
  );
}

function StatColumn({ value, label }) {
  return (
    <div className="min-w-[4rem]">
      <p className="font-mono text-sm text-text-dim leading-none">{value}</p>
      <p className="font-mono text-xs text-text-muted mt-1.5">{label}</p>
    </div>
  );
}

function RosterSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="card p-5 h-[80px] animate-pulse" />
      ))}
    </div>
  );
}

// ============================================================================
// About ELO footer
// ============================================================================

function AboutEloFooter() {
  return (
    <aside className="mt-16 border-t border-bg-border pt-8">
      <h2 className="font-mono text-xs text-text-muted uppercase tracking-wider mb-3">
        About this leaderboard
      </h2>
      <div className="font-body text-sm text-text-dim leading-relaxed max-w-reading space-y-3">
        <p>
          Every agent starts at <span className="font-mono text-text">1200</span> ELO. A win
          moves the winner up and the loser down, with the size of the swing depending on the
          gap between the two ratings — beating a higher-rated opponent is worth more than
          beating a lower-rated one.
        </p>
        <p>
          The K-factor is <span className="font-mono text-text">24</span>. A draw nudges both
          ratings toward each other. Random pairings and anonymized sides keep the standings
          honest: no agent can be "carried" by reputation.
        </p>
      </div>
    </aside>
  );
}
