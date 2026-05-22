import { Outlet } from 'react-router-dom';
import Nav from './Nav.jsx';

export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-bg-border mt-16">
        <div className="max-w-content mx-auto px-6 py-8 flex items-center justify-between text-sm font-mono text-text-muted">
          <span>debate arena · darvinyi</span>
          <a
            href="https://github.com/yidarvin"
            target="_blank"
            rel="noreferrer"
            className="hover:text-text-dim transition-colors"
          >
            github.com/yidarvin
          </a>
        </div>
      </footer>
    </div>
  );
}
