import { useParams } from 'react-router-dom';

export default function Debate() {
  const { id } = useParams();
  return (
    <div className="max-w-content mx-auto px-6 py-16">
      <h1 className="font-display text-display-md mb-2">Debate Viewer</h1>
      <p className="font-mono text-sm text-text-muted">id: {id}</p>
      <p className="font-body text-text-dim mt-4">
        Live debate viewer. Implemented in Prompt 18.
      </p>
    </div>
  );
}
