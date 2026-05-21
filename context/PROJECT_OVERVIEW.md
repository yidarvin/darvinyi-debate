# darvinyi-debate — project overview

## What this is

A public multi-agent debate platform. Users submit a proposition. Two randomly selected LLM agents are assigned opposing sides and debate it under simplified Lincoln–Douglas rules. A judge model scores the result. ELO ratings update after every debate. Anyone can watch debates and view the leaderboard; only the holder of a secret keyphrase can start new debates (to gate API spend).

The platform deploys to `debate.darvinyi.com` as part of the darvinyi.com personal portfolio.

## Stack

- **Backend:** Node.js (ESM) + Express + Prisma + PostgreSQL
- **Frontend:** React 18 + Vite + Tailwind CSS v3 + React Router v6 + Recharts
- **Streaming:** native Server-Sent Events (no socket.io, no third-party realtime)
- **Deployment:** single Railway service with attached PostgreSQL
- **DNS:** Namecheap (subdomain CNAME to Railway)

## Repo structure

```
darvinyi-debate/
├── /context              # spec documents (read by every Claude Code session)
├── /research             # reference materials (e.g. visual prototype)
├── /server               # Express backend
│   ├── /prisma
│   │   └── schema.prisma
│   ├── /scripts          # one-off test scripts
│   ├── /src
│   │   ├── /agents       # AgentRunner + provider adapters
│   │   ├── /elo          # rating calculation + persistence
│   │   ├── /judge        # evaluation agent
│   │   ├── /middleware   # auth, rate limit
│   │   ├── /orchestrator # debate flow control
│   │   ├── /routes       # Express routers
│   │   ├── /tools        # universal web_fetch, etc.
│   │   ├── db.js
│   │   ├── seed.js
│   │   └── index.js
│   ├── package.json
│   └── .env.example
├── /client               # React frontend
│   ├── /src
│   │   ├── /components
│   │   ├── /lib
│   │   ├── /pages
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── .env.example
│   └── .env.production
├── package.json          # root, controls Railway build/start
├── README.md
└── .gitignore
```

## Local development

The full local quickstart is documented in `/README.md`. At a high level:

1. Have PostgreSQL running locally (or use Railway's database URL).
2. From repo root: `npm install` (installs root + workspaces).
3. Copy `server/.env.example` to `server/.env`, fill in API keys + `DATABASE_URL` + `DEBATE_KEYPHRASE`.
4. Copy `client/.env.example` to `client/.env`.
5. From `/server`: `npx prisma migrate dev --name init && node src/seed.js`.
6. From `/server`: `npm run dev` (starts Express on :3001).
7. From `/client`: `npm run dev` (starts Vite on :5173, proxies `/api` to :3001).

## Conventions

- **Modules:** ESM throughout. `"type": "module"` in every package.json. Use `import`/`export`, never `require`.
- **No TypeScript.** Plain JS + JSDoc when types help.
- **Async:** `async`/`await` always. No `.then` chains. No callbacks except in event emitters and streaming APIs.
- **Naming:** kebab-case for file names except React components (PascalCase, `.jsx`). Function names camelCase. Constants UPPER_SNAKE_CASE.
- **Error responses:** Always `{ error: "human-readable message" }` with appropriate HTTP status. Never leak stack traces in production.
- **Timestamps:** Always ISO 8601 strings at API boundaries. Prisma `DateTime` in the database.
- **HTTP:** REST conventions. JSON request and response bodies. No GraphQL.
- **Streaming:** Server-Sent Events with named events (`event: type\ndata: <json>\n\n` format). No WebSockets.
- **Comments:** Sparingly. Comment *why* something is non-obvious, not *what* the code does.
- **No global state.** Pass dependencies explicitly. Prisma client is the one exception (singleton in `server/src/db.js`).

## Out of scope (do not build)

- User accounts, login, social auth
- Profile pages for human users
- Comments or chat on debates
- Email or notifications
- Manual agent selection (random only at launch)
- Multiple debate formats (Lincoln–Douglas only at launch)
- Tournaments or bracketed competitions
- Mobile-specific layouts (responsive desktop-first; mobile is acceptable but not optimized)
