import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { fetchJson, ApiError } from '../api.js';

// Hex values matching design tokens from /client/tailwind.config.js.
// Recharts can't read Tailwind classes — these have to be literals.
const COLORS = {
  accent: '#22d3ee',
  bgElevated: '#141414',
  bgBorder: '#262626',
  textSubtle: '#71717a',
  textMuted: '#52525b',
  textDim: '#a1a1aa',
  text: '#f4f4f5',
};

const STARTING_ELO = 1200;

// ============================================================================
// Page
// ============================================================================

export default function Agent() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetchJson(`/agents/${encodeURIComponent(id)}`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Server returns recentDebates without per-row ELO deltas; build a lookup
  // from eloHistory so each row can show its swing.
  const deltaByDebateId = useMemo(() => {
    const map = new Map();
    for (const point of data?.eloHistory ?? []) {
      if (point?.debateId) map.set(point.debateId, point.delta);
    }
    return map;
  }, [data]);

  if (error instanceof ApiError && error.status === 404) {
    return <AgentNotFound id={id} />;
  }

  if (loading) {
    return <LoadingState />;
  }

  if (error) {
    return (
      <div className="max-w-content mx-auto px-6 py-16">
        <p className="font-mono text-sm text-text-muted">
          Couldn't load agent ({error.message ?? 'unknown'}).
        </p>
      </div>
    );
  }

  if (!data?.agent) return null;

  return (
    <div className="max-w-content mx-auto px-6 py-12 md:py-16">
      <ProfileHeader agent={data.agent} />
      <StatsRow agent={data.agent} humanVoteStats={data.humanVoteStats ?? null} />
      <EloChart eloHistory={data.eloHistory ?? []} />
      <RecentDebatesSection
        recentDebates={data.recentDebates ?? []}
        deltaByDebateId={deltaByDebateId}
      />
    </div>
  );
}

// ============================================================================
// Profile header
// ============================================================================

function ProfileHeader({ agent }) {
  return (
    <header className="mb-10">
      <p className="font-mono text-xs text-text-muted uppercase tracking-[0.2em] mb-3">
        {agent.provider}
      </p>
      <h1 className="font-display text-display-md md:text-display-lg text-text leading-tight">
        {agent.displayName}
      </h1>
      <p className="font-mono text-sm text-text-dim mt-3">{agent.modelId}</p>
    </header>
  );
}

// ============================================================================
// Stats row
// ============================================================================

function StatsRow({ agent, humanVoteStats }) {
  const total = (agent.wins ?? 0) + (agent.losses ?? 0) + (agent.draws ?? 0);
  const winRate = total > 0 ? Math.round(((agent.wins ?? 0) / total) * 100) : null;

  const humanVoted = humanVoteStats?.totalVotes ?? 0;
  const overridden = humanVoteStats?.judgeOverridden ?? 0;

  const humanVotedValue =
    total === 0 || humanVoted === 0 ? '—' : `${humanVoted} of ${total}`;
  const humanVotedSubline =
    humanVoted === 0
      ? null
      : overridden === 0
      ? 'all confirmed'
      : `${overridden} overridden`;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4 mb-12">
      <StatCard label="ELO"     value={Math.round(agent.elo ?? STARTING_ELO).toLocaleString()} accent />
      <StatCard label="Record"  value={total > 0 ? `${agent.wins}-${agent.losses}-${agent.draws}` : '—'} />
      <StatCard label="Win rate" value={winRate === null ? '—' : `${winRate}%`} />
      <StatCard label="Debates" value={total.toLocaleString()} />
      <StatCard label="Human-voted" value={humanVotedValue} subline={humanVotedSubline} />
    </div>
  );
}

function StatCard({ label, value, accent, subline }) {
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
      {subline && (
        <p className="font-mono text-[10px] text-text-muted mt-2 truncate">
          {subline}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// ELO trajectory chart
// ============================================================================

function EloChart({ eloHistory }) {
  const chartData = useMemo(() => {
    if (!eloHistory || eloHistory.length === 0) return [];
    // Prepend synthetic starting point so the line shows the journey from 1200.
    return [
      { debate: 0, elo: STARTING_ELO, delta: 0 },
      ...eloHistory.map((point, idx) => ({
        debate: idx + 1,
        elo: Math.round(point.after),
        delta: Math.round(point.delta),
      })),
    ];
  }, [eloHistory]);

  return (
    <section className="mb-12">
      <h2 className="font-display text-xl md:text-2xl text-text mb-4">
        ELO trajectory
      </h2>

      <div className="card p-4 md:p-5">
        {chartData.length === 0 ? (
          <div className="py-12 text-center">
            <p className="font-mono text-sm text-text-muted">
              No debates yet. The trajectory will appear here once this agent has debated.
            </p>
          </div>
        ) : (
          <div className="w-full" style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 16, right: 24, bottom: 8, left: -8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgBorder} />
                <XAxis
                  dataKey="debate"
                  tick={{ fill: COLORS.textSubtle, fontFamily: 'JetBrains Mono', fontSize: 11 }}
                  axisLine={{ stroke: COLORS.bgBorder }}
                  tickLine={{ stroke: COLORS.bgBorder }}
                  label={{
                    value: 'debate #',
                    position: 'insideBottom',
                    offset: -4,
                    fill: COLORS.textMuted,
                    fontSize: 10,
                    fontFamily: 'JetBrains Mono',
                  }}
                />
                <YAxis
                  domain={['dataMin - 20', 'dataMax + 20']}
                  tick={{ fill: COLORS.textSubtle, fontFamily: 'JetBrains Mono', fontSize: 11 }}
                  axisLine={{ stroke: COLORS.bgBorder }}
                  tickLine={{ stroke: COLORS.bgBorder }}
                  width={50}
                />
                <Tooltip
                  contentStyle={{
                    background: COLORS.bgElevated,
                    border: `1px solid ${COLORS.bgBorder}`,
                    borderRadius: 6,
                    padding: '8px 12px',
                  }}
                  labelStyle={{
                    color: COLORS.textDim,
                    fontFamily: 'JetBrains Mono',
                    fontSize: 11,
                    marginBottom: 4,
                  }}
                  itemStyle={{
                    color: COLORS.accent,
                    fontFamily: 'JetBrains Mono',
                    fontSize: 12,
                  }}
                  cursor={{ stroke: COLORS.textMuted, strokeDasharray: '3 3' }}
                  formatter={(value, _, props) => {
                    const delta = props?.payload?.delta;
                    const deltaStr =
                      delta && delta !== 0
                        ? ` (${delta > 0 ? '+' : ''}${delta})`
                        : '';
                    return [`${value}${deltaStr}`, 'ELO'];
                  }}
                  labelFormatter={(label) =>
                    label === 0 ? 'Start' : `Debate #${label}`
                  }
                />
                <ReferenceLine
                  y={STARTING_ELO}
                  stroke={COLORS.textMuted}
                  strokeDasharray="3 3"
                  label={{
                    value: 'start',
                    fill: COLORS.textMuted,
                    fontSize: 10,
                    fontFamily: 'JetBrains Mono',
                    position: 'insideRight',
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="elo"
                  stroke={COLORS.accent}
                  strokeWidth={2}
                  dot={{ fill: COLORS.accent, r: 3, strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: COLORS.accent }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}

// ============================================================================
// Recent debates
// ============================================================================

function RecentDebatesSection({ recentDebates, deltaByDebateId }) {
  return (
    <section>
      <h2 className="font-display text-xl md:text-2xl text-text mb-4">
        Recent debates
      </h2>

      {recentDebates.length === 0 ? (
        <div className="border border-dashed border-bg-border rounded-lg py-12 px-6 text-center">
          <p className="font-mono text-sm text-text-muted">No debates yet.</p>
        </div>
      ) : (
        <ol className="space-y-2.5">
          {recentDebates.map((debate) => (
            <li key={debate.id}>
              <RecentDebateRow
                debate={debate}
                delta={deltaByDebateId.get(debate.id)}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RecentDebateRow({ debate, delta }) {
  const sideTokens =
    debate.side === 'aff'
      ? { color: 'text-side-aff', label: 'AFF' }
      : { color: 'text-side-neg', label: 'NEG' };

  const resultTokens =
    debate.result === 'win'
      ? { color: 'text-accent', label: 'Won' }
      : debate.result === 'loss'
      ? { color: 'text-red-400', label: 'Lost' }
      : { color: 'text-text-dim', label: 'Draw' };

  const hasDelta = typeof delta === 'number' && !Number.isNaN(delta);
  const deltaRounded = hasDelta ? Math.round(delta) : null;
  const deltaColor =
    !hasDelta
      ? 'text-text-muted'
      : deltaRounded > 0
      ? 'text-accent'
      : deltaRounded < 0
      ? 'text-red-400'
      : 'text-text-muted';
  const deltaSign = hasDelta && deltaRounded > 0 ? '+' : '';

  const opponent = debate.opponent?.displayName ?? '?';

  return (
    <Link
      to={`/debate/${encodeURIComponent(debate.id)}`}
      className="card p-4 md:p-5 hover:border-accent/40 transition-colors group block"
    >
      <p className="font-display text-text mb-2 group-hover:text-accent transition-colors line-clamp-1">
        {debate.topic}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs font-mono">
        <span className={sideTokens.color}>{sideTokens.label}</span>
        <Bullet />
        <span className="text-text-muted">
          vs <span className="text-text-dim">{opponent}</span>
        </span>
        <Bullet />
        <span className={resultTokens.color}>{resultTokens.label}</span>
        <Bullet />
        <span className={deltaColor}>
          {hasDelta ? `${deltaSign}${deltaRounded}` : '—'}
        </span>
        <span className="ml-auto text-text-muted whitespace-nowrap">
          {formatTimestamp(debate.completedAt)}
        </span>
      </div>
    </Link>
  );
}

function Bullet() {
  return (
    <span className="text-text-muted/40" aria-hidden="true">
      ·
    </span>
  );
}

// ============================================================================
// Empty / error / not-found states
// ============================================================================

function LoadingState() {
  return (
    <div className="max-w-content mx-auto px-6 py-12 md:py-16">
      <div className="mb-10">
        <div className="h-3 bg-bg-surface rounded w-16 mb-3 animate-pulse" />
        <div className="h-12 bg-bg-surface rounded w-2/3 mb-3 animate-pulse" />
        <div className="h-4 bg-bg-surface rounded w-48 animate-pulse" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4 mb-12">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="card p-5 h-[88px] animate-pulse" />
        ))}
      </div>
      <div className="card p-5 h-[320px] animate-pulse mb-12" />
      <div className="space-y-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="card p-5 h-[64px] animate-pulse" />
        ))}
      </div>
    </div>
  );
}

function AgentNotFound({ id }) {
  return (
    <div className="max-w-reading mx-auto px-6 py-24 text-center">
      <p className="font-mono text-sm text-accent uppercase tracking-wider mb-3">404</p>
      <h1 className="font-display text-display-md text-text mb-4">Agent not found</h1>
      <p className="font-body text-text-dim mb-2">
        No agent with that id exists.
      </p>
      <p className="font-mono text-xs text-text-muted mb-8">{id}</p>
      <div className="flex gap-3 justify-center flex-wrap">
        <Link to="/leaderboard" className="btn-primary">
          See the roster
          <span aria-hidden="true">→</span>
        </Link>
        <Link to="/" className="btn-secondary">
          Back to arena
        </Link>
      </div>
    </div>
  );
}

// ============================================================================
// Time formatting (copy of the helper from Debates.jsx — duplicated intentionally)
// ============================================================================

function formatTimestamp(iso) {
  if (!iso) return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'just now';

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
