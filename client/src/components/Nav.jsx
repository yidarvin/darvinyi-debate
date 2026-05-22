import { NavLink, Link } from 'react-router-dom';

const NAV_LINKS = [
  { to: '/',            label: 'Arena',       end: true },
  { to: '/new',         label: 'New Debate',  end: false },
  { to: '/debates',     label: 'Past',        end: false },
  { to: '/leaderboard', label: 'Leaderboard', end: false },
];

export default function Nav() {
  return (
    <header className="border-b border-bg-border bg-bg/80 backdrop-blur sticky top-0 z-10">
      <div className="max-w-content mx-auto px-6 h-16 flex items-center justify-between">
        <Link to="/" className="group flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-accent shadow-[0_0_12px_rgba(34,211,238,0.6)] group-hover:animate-pulse-soft" />
          <span className="font-display text-xl text-text tracking-tight">
            debate <span className="text-accent">arena</span>
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                [
                  'px-3 py-1.5 rounded-md text-sm font-mono transition-colors',
                  isActive
                    ? 'text-accent bg-accent/10'
                    : 'text-text-dim hover:text-text hover:bg-bg-elevated',
                ].join(' ')
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
