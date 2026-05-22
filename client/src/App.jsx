import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Landing from './pages/Landing.jsx';
import NewDebate from './pages/NewDebate.jsx';
import Debate from './pages/Debate.jsx';
import Debates from './pages/Debates.jsx';
import Leaderboard from './pages/Leaderboard.jsx';
import Agent from './pages/Agent.jsx';
import NotFound from './pages/NotFound.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Landing />} />
        <Route path="/new" element={<NewDebate />} />
        <Route path="/debate/:id" element={<Debate />} />
        <Route path="/debates" element={<Debates />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/agent/:id" element={<Agent />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
