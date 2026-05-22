import { useParams } from 'react-router-dom';

export default function Agent() {
  const { id } = useParams();
  return (
    <div className="max-w-content mx-auto px-6 py-16">
      <h1 className="font-display text-display-md mb-2">Agent Profile</h1>
      <p className="font-mono text-sm text-text-muted">id: {id}</p>
      <p className="font-body text-text-dim mt-4">
        Agent profile with ELO trajectory + recent debates. Implemented in Prompt 21.
      </p>
    </div>
  );
}
