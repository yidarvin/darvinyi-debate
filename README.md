# darvinyi-debate

Public multi-agent debate arena. Two frontier LLMs are randomly selected, anonymized, and assigned opposing sides of a user-submitted proposition. They debate under simplified Lincoln–Douglas rules with full access to web search and fetch. A judge model scores the result. ELO ratings update after every debate.

Live at [debate.darvinyi.com](https://debate.darvinyi.com).

## Stack

- **Backend:** Node 20+ · Express · Prisma · PostgreSQL
- **Frontend:** React 18 · Vite · Tailwind CSS · React Router · Recharts
- **Streaming:** native Server-Sent Events
- **Deployment:** single Railway service

## Roster

| Agent | Provider | Model |
|---|---|---|
| Claude Opus 4.7 | Anthropic | `claude-opus-4-7` |
| Claude Sonnet 4.6 | Anthropic | `claude-sonnet-4-6` |
| GPT-5 | OpenAI | `gpt-5` |
| Gemini 2.5 Pro | Google | `gemini-2.5-pro` |
| Grok 4 | xAI | `grok-4` |

Judge: always Claude Opus 4.7. Judge sees anonymized debate text (no agent identities).

## Local development

### Prerequisites

- Node.js 20 or higher
- PostgreSQL 15+ running locally (or a hosted database URL)
- API keys for: Anthropic, OpenAI, Google AI Studio, xAI

### Setup

```sh
# 1. Install all dependencies (root, server, client)
npm install

# 2. Configure environment
cp server/.env.example server/.env
cp client/.env.example client/.env
# Edit server/.env: add API keys, DATABASE_URL, and a DEBATE_KEYPHRASE

# 3. Initialize the database
cd server
npx prisma migrate dev --name init
node src/seed.js
cd ..

# 4. Run dev servers in two terminals
npm run dev:server   # Express on :3001
npm run dev:client   # Vite on :5173
```

Visit http://localhost:5173.

## Architecture

Single-service deployment. The Express server in `/server` serves:
- `/api/*` — JSON and SSE routes
- everything else — static files from `/client/dist` (in production only) with SPA fallback

The React app builds to `/client/dist`, which Express picks up at runtime.

See `/context/ARCHITECTURE.md` for full details.

## Project structure

```
/context           Spec documents read by every Claude Code session
/research          Visual prototype and reference materials
/server            Express backend
  /prisma          Schema and migrations
  /src
    /agents        AgentRunner base class and provider adapters
    /elo           Rating calculation
    /judge         Evaluation agent
    /middleware    Auth, rate limit
    /orchestrator  Debate flow control
    /routes        Express routers
    /tools         Universal web_fetch
/client            React frontend
  /src
    /components    Shared components
    /lib           API client, utilities
    /pages         Top-level pages
```

## Deployment (Railway)

The whole project deploys as a single Railway service with an attached PostgreSQL database.

### Initial setup

1. **Create the Railway project** and add a PostgreSQL database service.
2. **Add a service from this GitHub repo.** Railway autodetects Node via Nixpacks.
3. **Set environment variables** on the service (in Railway's Variables panel):
   - `DATABASE_URL` — reference the Postgres service's `DATABASE_URL` variable using Railway's variable reference syntax (`${{Postgres.DATABASE_URL}}` or via the UI selector)
   - `ANTHROPIC_API_KEY`
   - `OPENAI_API_KEY`
   - `GOOGLE_API_KEY`
   - `XAI_API_KEY`
   - `DEBATE_KEYPHRASE` (pick something strong)
   - `NODE_ENV=production`
   - `PORT` — do NOT set this. Railway sets it automatically.
4. **Generate the service domain** by clicking "Generate Domain" in the Railway service UI. Railway does not auto-create a public domain.
5. **First deploy will run automatically** — Railway pulls from main, runs the build (which installs deps, runs `prisma generate`, and builds the client), then runs the start command (which runs `prisma migrate deploy`, seeds the agents, and starts Express).
6. **Visit the generated URL.** The landing page should load and the leaderboard should show 5 agents at 1200 ELO each.

### Custom domain (debate.darvinyi.com)

1. In the Railway service settings, add custom domain `debate.darvinyi.com`. Railway provides a CNAME target.
2. Add the CNAME at Namecheap for the `debate` subdomain.
3. Wait for DNS propagation (a few minutes) and SSL provisioning.
4. Visit the custom domain to confirm.

### Critical Railway gotchas (these have bitten prior projects)

1. **`VITE_API_URL` MUST be hardcoded in `/client/.env.production`** (already done — committed to repo as empty string). Setting it via Railway's Variables panel will NOT work; Vite does not see Railway Variables as build args.

2. **`postinstall: prisma generate` is required in `/server/package.json`** — added by Prompt 3 when the schema is created. Without it, the Prisma client is not generated during Railway's build and the server crashes on startup.

3. **The start command runs migrations and seed before the server.** The root `package.json` start script handles this:
   ```
   cd server && npx prisma migrate deploy && node src/seed.js && node src/index.js
   ```
   The seed script must be idempotent — it runs on every deploy.

4. **Railway has no shell access.** Migrations and seeding cannot happen out-of-band; everything must go through the start command. If a migration is broken, the deploy fails.

5. **Trust `X-Forwarded-For` in production** for rate limiting. Railway terminates SSL upstream of the service.

## Costs

Each debate costs roughly $0.40–$1.50 in API spend, depending on which agents are selected (Opus is the most expensive; Gemini and Grok are cheapest). The keyphrase + per-IP rate limit (3/day) bounds total spend.

## License

UNLICENSED — personal portfolio project. Source available for reference; not for redistribution.
