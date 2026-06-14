# AI Voice Platform Backend

TypeScript Express API setup with MongoDB via Mongoose.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Update `MONGODB_URI` in `.env` when using MongoDB Atlas or another database.
Set `JWT_SECRET` to a long random string before using real accounts.

## Auth Endpoints

- `POST /api/auth/register` creates a user and returns a JWT.
- `POST /api/auth/login` signs in with email/password and returns a JWT.
- `GET /api/auth/me` returns the current user when sent `Authorization: Bearer <token>`.

## Scripts

- `npm run dev` starts the API in watch mode.
- `npm run agent:dev` starts the named LiveKit realtime agent worker.
- `npm run build` compiles TypeScript to `dist`.
- `npm start` runs the compiled server.
- `npm run agent:start` runs the compiled agent worker.
- `npm run typecheck` checks TypeScript without emitting files.

Run both `npm run dev` and `npm run agent:dev` for local voice calls. The API
creates browser tokens, SIP calls, and phone routes; the worker joins those
rooms and runs the selected OpenAI Realtime, Gemini Live, or Sarvam voice
pipeline.

## Voice API

All voice endpoints require the existing bearer-token authentication.

- `GET /api/voice/config` returns LiveKit, SIP, and provider availability.
- `GET|POST|PUT /api/voice/agents` manages persisted voice agents.
- `POST /api/voice/web-call-token` creates a one-time browser room token.
- `POST /api/voice/outbound-calls` starts a call through the outbound SIP trunk.
- `GET|PUT|DELETE /api/voice/integrations/vobiz` manages the signed-in user's Vobiz connection.
- `GET /api/voice/vobiz/numbers` lists numbers owned by that user's connected Vobiz account.
- `GET /api/voice/vobiz/inventory` browses numbers that user can purchase from Vobiz.
- `POST /api/voice/phone-numbers/import` assigns an owned Vobiz number to an agent.
- `POST /api/voice/phone-numbers/purchase` purchases from Vobiz, then assigns the number.
- `POST /api/voice/phone-numbers/sync` checks Vobiz numbers and LiveKit SIP trunks.

Each user connects their own Vobiz account from the phone-number dashboard.
Provider tokens are encrypted at rest, scoped by user ID, and never returned to
the browser after connection. Vobiz owns, sells, and bills the phone number;
the platform connects imported numbers to the selected AI agent.
