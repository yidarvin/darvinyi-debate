import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="max-w-reading mx-auto px-6 py-24 text-center">
      <p className="font-mono text-sm text-accent mb-4">404</p>
      <h1 className="font-display text-display-md mb-4">Page not found</h1>
      <p className="font-body text-text-dim mb-8">
        That path doesn't exist (yet, anyway).
      </p>
      <Link to="/" className="btn-primary">Back to arena</Link>
    </div>
  );
}
