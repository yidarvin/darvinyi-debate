import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson } from '../api.js';

const PAGE_SIZE = 20;

// ============================================================================
// Page
// ============================================================================

export default function Debates() {
  const [debates, setDebates] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  // Initial load.
  useEffect(() => {
    let cancelled = false;

    fetchPage(null)
      .then((res) => {
        if (cancelled) return;
        setDebates(res.debates);
        setCursor(res.nextCursor);
        setHasMore(!!res.nextCursor);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message ?? 'unknown');
      })
      .finally(() => {
        if (!cancelled) setInitialLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore || !cursor) return;

    setLoadingMore(true);
    setError(null);

    try {
      const res = await fetchPage(cursor);
      setDebates((prev) => [...prev, ...res.debates]);
      setCursor(res.nextCursor);
      setHasMore(!!res.nextCursor);
    } catch (err) {
      setError(err.message ?? 'unknown');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="max-w-content mx-auto px-6 py-12 md:py-16">
      <PageHeader debateCount={debates.length} hasMore={hasMore} loading={initialLoading} />

      <section className="mt-8">
        {initialLoading && <ListSkeleton />}

        {!initialLoading && error && debates.length === 0 && (
          <p className="font-mono text-sm text-text-muted">
            Couldn't load debates ({error}).
          </p>
        )}

        {!initialLoading && debates.length === 0 && !error && <EmptyState />}

        {debates.length > 0 && (
          <ol className="space-y-2.5">
            {debates.map((debate) => (
              <li key={debate.id}>
                <DebateRow debate={debate} />
              </li>
            ))}
          </ol>
        )}

        {!initialLoading && hasMore && (
          <LoadMoreButton onClick={handleLoadMore} loading={loadingMore} />
        )}

        {!initialLoading && !hasMore && debates.length > 0 && (
          <p className="mt-10 font-mono text-xs text-text-muted text-center">
            End of list.
          </p>
        )}

        {error && debates.length > 0 && (
          <p className="mt-4 font-mono text-xs text-red-400/80 text-center">
            Failed to load more ({error}). Try again.
          </p>
        )}
      </section>
    </div>
  );
}

// ============================================================================
// Data fetching
// ============================================================================

async function fetchPage(before) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (before) params.set('before', before);
  return fetchJson(`/debates?${params.toString()}`);
}

// ============================================================================
// Header
// ============================================================================

function PageHeader({ debateCount, hasMore, loading }) {
  let countLabel;
  if (loading) {
    countLabel = null;
  } else if (debateCount === 0) {
    countLabel = 'No debates yet';
  } else if (hasMore) {
    countLabel = `Showing the most recent ${debateCount}`;
  } else {
    countLabel = `${debateCount} debate${debateCount === 1 ? '' : 's'} total`;
  }

  return (
    <header>
      <h1 className="font-display text-display-md md:text-display-lg text-text">
        Past debates
      </h1>
      <p className="font-body text-text-dim mt-2 max-w-reading leading-relaxed">
        Every completed debate, most recent first. Click any one to replay the rounds, see the
        judge's reasoning, and check the ELO swing.
      </p>
      {countLabel && (
        <p className="font-mono text-xs text-text-muted mt-4 uppercase tracking-wider">
          {countLabel}
        </p>
      )}
    </header>
  );
}

// ============================================================================
// Debate row
// ============================================================================

function DebateRow({ debate }) {
  const aff = debate.affAgent?.displayName ?? '?';
  const neg = debate.negAgent?.displayName ?? '?';

  let verdictNode = null;
  if (debate.winner === 'aff') {
    verdictNode = (
      <span className="text-side-aff">
        AFF won <span className="text-side-aff/60">— {aff}</span>
      </span>
    );
  } else if (debate.winner === 'neg') {
    verdictNode = (
      <span className="text-side-neg">
        NEG won <span className="text-side-neg/60">— {neg}</span>
      </span>
    );
  } else if (debate.winner === 'draw') {
    verdictNode = <span className="text-text-dim">Draw</span>;
  } else {
    verdictNode = <span className="text-text-muted">Unresolved</span>;
  }

  return (
    <Link
      to={`/debate/${encodeURIComponent(debate.id)}`}
      className="card p-5 hover:border-accent/40 transition-colors group block"
    >
      <p className="font-display text-base md:text-lg text-text mb-3 group-hover:text-accent transition-colors leading-snug line-clamp-2">
        {debate.topic}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs font-mono">
        <span className="text-text-muted truncate">
          {aff} <span className="text-text-muted/50">vs</span> {neg}
        </span>
        <Bullet />
        {verdictNode}
        <Bullet />
        <time className="text-text-muted whitespace-nowrap" dateTime={debate.completedAt ?? undefined}>
          {formatTimestamp(debate.completedAt)}
        </time>
      </div>
    </Link>
  );
}

function Bullet() {
  return <span className="text-text-muted/40" aria-hidden="true">·</span>;
}

// ============================================================================
// Empty state
// ============================================================================

function EmptyState() {
  return (
    <div className="border border-dashed border-bg-border rounded-lg py-16 px-6 text-center">
      <p className="font-body text-text-dim mb-5 max-w-reading mx-auto">
        No completed debates yet. They'll appear here once the agents have argued.
      </p>
      <Link to="/new" className="btn-primary">
        Start the first one
        <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

// ============================================================================
// Load more
// ============================================================================

function LoadMoreButton({ onClick, loading }) {
  return (
    <div className="mt-8 flex justify-center">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="btn-secondary min-w-[10rem] justify-center disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <SpinnerDot />
            Loading…
          </>
        ) : (
          <>Load more</>
        )}
      </button>
    </div>
  );
}

function SpinnerDot() {
  return (
    <span
      className="relative inline-flex items-center justify-center w-3 h-3"
      aria-hidden="true"
    >
      <span className="absolute w-3 h-3 rounded-full bg-accent/30 animate-ping" />
      <span className="relative w-2 h-2 rounded-full bg-accent" />
    </span>
  );
}

// ============================================================================
// Skeleton
// ============================================================================

function ListSkeleton() {
  return (
    <ol className="space-y-2.5">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="card p-5 animate-pulse">
          <div className="h-5 bg-bg-surface rounded w-4/5 mb-2" />
          <div className="h-5 bg-bg-surface rounded w-2/3 mb-4" />
          <div className="h-3 bg-bg-surface rounded w-1/2" />
        </li>
      ))}
    </ol>
  );
}

// ============================================================================
// Time formatting
// ============================================================================

function formatTimestamp(iso) {
  if (!iso) return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const nowMs = Date.now();
  const diffMs = nowMs - date.getTime();

  // Future timestamps (clock skew) → treat as "just now"
  if (diffMs < 0) return 'just now';

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  // Older than a week: absolute date.
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
