# Architecture

## Deployment topology

Single Railway service. The Express server in `/server` is the only running process. It does two jobs:

1. Serves `/api/*` JSON and SSE routes.
2. In production (`NODE_ENV=production`), serves the static React build from `/client/dist` with SPA fallback for non-`/api/*` paths.

A PostgreSQL database is attached as a separate Railway service. The Express service receives `DATABASE_URL` from Railway as an environment variable.

There is no separate frontend hosting (no Vercel, no Netlify). The React app is built during Railway's build step (`cd client && npm install && npm run build`) and served by Express.

## Request flow — read endpoints

```
Browser → GET /api/agents
       → Express agents router
       → Prisma query
       → JSON response
```

No streaming, no auth, no special handling. Standard REST.

## Request flow — debate creation

```
Browser → POST /api/debates (with X-Debate-Key header)
       → requireKeyphrase middleware       (401 if wrong)
       → rateLimit middleware              (429 if exceeded)
       → pickRandomAgents()                (selects 2 distinct agents)
       → Prisma create Debate row, status='pending'
       → 201 { debateId }

Browser → redirects to /debate/:id
       → opens EventSource to GET /api/debates/:id/stream
       → Express debates router /stream handler
       → reads debate row
         if status='pending':
           → runDebate(debateId, onEvent) [streams via SSE]
           → judgeDebate(debateId, onEvent) [streams via SSE]
           → applyEloChange(debateId) [single event]
           → debate_complete event
           → close SSE connection
         if status='in_progress':
           → replay saved turns, close (no live resume in v1)
         if status='completed' or 'failed':
           → send full saved state via single events, close
```

## Streaming model — SSE

Native Server-Sent Events. No socket.io. Server writes events in the standard SSE wire format:

```
event: <event_name>
data: <JSON payload>

```

(Two newlines terminate each event.)

The client consumes via `EventSource` (built into all browsers). Named events let the client dispatch on event type without sniffing the payload.

### Event types

| Event | Payload | Notes |
|---|---|---|
| `debate_start` | `{ debateId, topic }` | Identities NOT revealed |
| `text_delta` | `{ round, side, text }` | Partial token stream from a debater |
| `tool_call_start` | `{ round, side, tool, input }` | Tool invocation begins |
| `tool_call_end` | `{ round, side, tool, outputSummary }` | Tool invocation completed |
| `round_complete` | `{ round, side, content, toolCalls, tokensIn, tokensOut, durationMs }` | A debater's turn is finalized |
| `all_rounds_complete` | `{}` | All six rounds are done |
| `judge_thinking` | `{}` | Judge has begun evaluating |
| `judge_text_delta` | `{ text }` | Optional: stream the judge's reasoning |
| `evaluation_complete` | `{ winner, affScores, negScores, reasoning }` | Judge has finished |
| `elo_updated` | `{ changes: [{ agentId, before, after, delta }] }` | New ratings persisted |
| `debate_complete` | `{ debateId, affAgent, negAgent, winner, evaluation, eloChanges }` | Final reveal of identities |
| `error` | `{ message }` | Recoverable error inside stream |

When the client receives `debate_complete`, the connection is closed by the server. The client should then dispose of the EventSource.

## File structure conventions

### Server (`/server/src/`)

- `index.js` — Express app, middleware wiring, route mounting, static serving, port listen
- `db.js` — singleton PrismaClient
- `seed.js` — idempotent agent seeding (runs on every Railway start)
- `routes/` — one file per resource (`agents.js`, `debates.js`)
- `middleware/` — `auth.js` (keyphrase), `rateLimit.js`
- `agents/` — `AgentRunner.js` (base), one file per provider (`AnthropicAgent.js`, `OpenAIAgent.js`, `GoogleAgent.js`, `XaiAgent.js`), `systemPrompts.js`, `index.js` (factory)
- `tools/` — `webFetch.js` (universal tool implementation + schema export)
- `orchestrator/` — `rounds.js` (round definitions), `buildConversation.js`, `pickAgents.js`, `runDebate.js`
- `judge/` — `judgeDebate.js`
- `elo/` — `calculate.js` (pure function), `applyEloChange.js` (DB writes)

### Client (`/client/src/`)

- `main.jsx` — React root + BrowserRouter
- `App.jsx` — Routes + Layout wrapping
- `index.css` — Tailwind directives, font imports, CSS variable definitions, component utility classes
- `lib/api.js` — fetch helpers, SSE wrapper
- `components/` — Layout, Card, Button, PulseDot, ToolCallBadge, ScoreBar, etc.
- `pages/` — Home, NewDebate, DebateViewer, PastDebates, Leaderboard, AgentProfile, NotFound

## Critical Railway constraints

The following are non-obvious failure modes from prior projects. Each must be honored.

1. **`VITE_API_URL` must be hardcoded in `/client/.env.production`.** Railway does NOT pass service Variables to Vite as build args. Setting `VITE_API_URL` in Railway's Variables panel will NOT take effect at build time. For this project, `.env.production` should contain `VITE_API_URL=` (empty string), so the client makes same-origin requests in production. The `.env.production` file MUST be committed to the repo.

2. **`postinstall: prisma generate` in `/server/package.json` is required.** Without it, the Prisma client is not generated during Railway's build and the server crashes on startup.

3. **Start command runs migration AND seed AND server.** The root `package.json` start script must be:
   ```
   cd server && npx prisma migrate deploy && node src/seed.js && node src/index.js
   ```
   `prisma migrate deploy` is the production migration command (not `migrate dev`). The seed script must be idempotent — it runs on every deploy.

4. **Railway has no shell access.** All migrations and seeding must happen via the start command. There is no opportunity to SSH in and run `prisma migrate`. If a migration is broken, the deploy fails and the service won't start.

5. **Service domain must be generated manually.** After deploying, click "Generate Domain" in the Railway service UI. Railway does not auto-create a public domain.

6. **PORT is set by Railway.** Read `process.env.PORT` and default to 3001 for local dev only. Do not hardcode the port in production.

7. **Trust the X-Forwarded-For header in production** for rate limiting. Railway terminates SSL upstream of the service, so `req.ip` is the load balancer's IP. Use the first IP in `X-Forwarded-For` when `NODE_ENV=production`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string (Railway provides) |
| `PORT` | (auto) | Set by Railway, defaults to 3001 in dev |
| `NODE_ENV` | yes in prod | `production` enables static serving + X-Forwarded-For trust |
| `ANTHROPIC_API_KEY` | yes | Used by AnthropicAgent + judge |
| `OPENAI_API_KEY` | yes | Used by OpenAIAgent |
| `GOOGLE_API_KEY` | yes | Used by GoogleAgent (Gemini) |
| `XAI_API_KEY` | yes | Used by XaiAgent (Grok) |
| `DEBATE_KEYPHRASE` | yes | Required for POST /api/debates |
| `CLIENT_DIST_PATH` | optional | Override path to client build (defaults `../client/dist` from server cwd) |
