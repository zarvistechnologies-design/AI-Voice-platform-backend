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
For production, set `NODE_ENV=production`, use unique strong values for
`JWT_SECRET` and `INTEGRATION_ENCRYPTION_KEY`, and restrict `CLIENT_URL` and
`ALLOWED_ORIGINS` to the deployed frontend origin.

Redis is optional. Set `REDIS_URL` to enable the shared, organization-scoped
cache for agent summaries and voice configuration; leave it empty to keep the
original database path. The cache fails open, has a maximum 15-second TTL, and
is invalidated after related agent, phone-routing, and Vobiz mutations. It does
not cache authentication, billing, calls, campaigns, live runtime state,
recordings, webhooks, provider credentials, or the phone-number response. Use a
private Redis instance and a `rediss://` TLS URL in production.
When running one-off smoke scripts without a reachable Redis service, leave
`REDIS_URL` unset so the script uses the normal database fallback and exits cleanly.
Use a deployment-specific `REDIS_KEY_PREFIX` such as `vozon:production`; do not
share the same prefix between staging and production. `REDIS_COMMAND_TIMEOUT_MS`
defaults to 250ms, after which dashboard reads fail open to MongoDB.

Before rolling the query changes into production, create the additive dashboard
indexes once in staging and then production during a low-traffic window:

```bash
npm run build
npm run migrate:phone-number-uniqueness
npm run setup:dashboard-indexes
```

These commands run compiled JavaScript, so they also work inside the production
Docker image (where development dependencies are not installed). The phone
migration audits canonical E.164 values and duplicate ownership first, then
converts the existing `number_1` index to unique without a drop/recreate gap. It
exits non-zero without deleting data when manual cleanup is required. The setup
command adds the remaining declared indexes without dropping existing indexes.
Review the output and verify representative queries with
`explain("executionStats")`.
It also creates TTL cleanup indexes for abandoned pending phone-number
reservations and transient call-admission leases. Phone import, purchase, call
admission, and deletion ownership are coordinated in MongoDB and do not depend
on Redis being available.

For Google sign-in, create a Google OAuth 2.0 Web client and set the same client ID as
`GOOGLE_CLIENT_ID` in the backend and `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in the frontend.
Add the frontend URL (for example `http://localhost:3000`) as an authorized JavaScript origin.

## Auth Endpoints

- `POST /api/auth/register` creates a user and returns a JWT.
- `POST /api/auth/login` signs in with email/password and returns a JWT.
- `POST /api/auth/google` verifies a Google ID token and signs in or creates the user.
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

## Retrieval knowledge base

The knowledge dashboard accepts text, public website URLs, PDF, DOCX, TXT,
Markdown, CSV, JSON, HTML, and XML sources. Sources are extracted, split into
overlapping chunks, embedded with `KNOWLEDGE_EMBEDDING_MODEL`, and searched
before every voice-agent response. Set `KNOWLEDGE_EMBEDDING_PROVIDER` to
`google` or `openai` and configure that provider's API key. When the provider
is omitted, Google is preferred when `GOOGLE_API_KEY` is available.

For production, create an Atlas Vector Search index named by
`KNOWLEDGE_VECTOR_INDEX` (default `knowledge_chunks_vector`) on the
`knowledgechunks` collection with:

- a `vector` field at path `embedding`, 1536 dimensions for
  `text-embedding-3-small`, and cosine similarity;
- filter fields at paths `ownerId`, `agentId`, and `embeddingModel`.

If the Atlas index is missing, the backend automatically falls back to cosine
search over the agent's stored chunks. This keeps local MongoDB development
functional, while Atlas Vector Search provides the production-scale path.

Run `npm run setup:knowledge-index` once for each Atlas database. The command
creates the index when missing and updates its definition when it already
exists.

## Voice API

All voice endpoints require the existing bearer-token authentication.

- `GET /api/voice/config` returns LiveKit, SIP, and provider availability.
- `GET|POST|PUT /api/voice/agents` manages persisted voice agents.
- `POST /api/voice/web-call-token` creates a one-time browser room token.
- `POST /api/voice/outbound-calls` starts a call through the outbound SIP trunk.
- `GET|POST /api/voice/campaigns` lists or creates durable outbound campaigns.
- `POST /api/voice/campaigns/:id/leads` uploads up to 500 idempotent leads per batch.
- `POST /api/voice/campaigns/:id/launch` starts immediately or schedules a campaign.
- `POST /api/voice/campaigns/:id/pause|resume|cancel` controls campaign execution.
- `GET|POST /api/voice/campaign-suppressions` manages the organization do-not-call list.
- `GET|PUT|DELETE /api/voice/integrations/vobiz` manages the signed-in user's Vobiz connection.
- `GET /api/voice/vobiz/numbers` lists numbers owned by that user's connected Vobiz account.
- `GET /api/voice/vobiz/inventory` browses numbers that user can purchase from Vobiz.
- `POST /api/voice/phone-numbers/import` assigns an owned Vobiz number to an agent.
- `POST /api/voice/phone-numbers/purchase` purchases from Vobiz, then assigns the number.
- `POST /api/voice/phone-numbers/sync` checks Vobiz numbers and LiveKit SIP trunks.

Each user connects their own Vobiz account from the phone-number dashboard.
Provider tokens are encrypted at rest, scoped by user ID, and never returned to
the browser after connection. Vobiz owns, sells, and bills the phone number;
Vobiz hands inbound PSTN calls to `LIVEKIT_SIP_URI` (or the LiveKit Cloud SIP
host inferred from `LIVEKIT_URL`), and LiveKit SIP dispatch rules connect those
inbound numbers to the selected AI agent.

`TELEPHONY_PROVIDER_TIMEOUT_MS` (default `12000`) is the absolute verification
deadline for Twilio, Exotel, and Vobiz phone imports. Inbound dispatch metadata
contains only the organization/agent locator; the LiveKit worker loads the
authoritative agent configuration from MongoDB before it constructs a voice
session. Agent configuration saves therefore do not rebuild SIP routes, while
phone assignment, activation, deletion, and explicit route sync still do.
After deploying this release, run `npm run migrate:inbound-route-metadata` once
from the built backend image. It updates every assigned inbound route in place
and exits non-zero if any number could not be reconciled.

Outbound SIP setup uses a durable CDR guard. A phone number cannot be changed
or deleted while setup is pending, even if the originating process loses its
short admission lease. If a process crashes during setup, first stop or drain
**every API and worker replica from that deployment** so the old owner cannot
resume. Then run exactly one scoped repair from the built image, for example:

```powershell
npm run repair:outbound-setups -- --call-id=<cdr-object-id> --confirm-processes-drained=YES
```

`--phone-number-id` and `--campaign-id` are also supported. The command refuses
unscoped recovery, refuses a still-active exact admission, and only clears the
guard after deleting the known LiveKit room and verifying it is absent. A
blocked or remaining guarded result exits with code 2; keep the deployment
drained, investigate LiveKit connectivity, and retry. Broad campaign/phone
scopes are repaired in bounded batches, so repeat until `remaining` is zero.
Restart replicas only after recovery succeeds.

## Production campaigns

Campaigns, leads, retries, daily limits, local calling windows, schedules, and
worker leases are persisted in MongoDB. The API process checks the queue every
five seconds. Atomic campaign leases and agent call slots allow multiple API
replicas to run the worker without placing the same call twice or exceeding an
agent's configured campaign concurrency.

Lead imports are idempotent by campaign and phone number. Upload large lists in
batches of 500. Suppressions are checked during import and again immediately
before dialing. A completed call whose structured output, tags, or end reason
indicates an opt-out is added to the organization suppression list.

For a real deployment, use a MongoDB replica set with backups, run multiple API
and LiveKit agent replicas, set provider concurrency quotas to match each
agent's `maxConcurrentCalls`, configure production secrets, and monitor
campaign `lastWorkerError` plus failed-lead counts. Run `npm run smoke:campaign`
after deployment without configuring it to dial: the smoke campaign is
scheduled in the future and removed during cleanup.

## Razorpay billing

The billing dashboard supports:

- USD wallet top-ups through Razorpay Standard Checkout.
- A recurring Enterprise subscription charging USD 500 monthly and adding USD 500 in wallet credits after each captured charge.
- Server-side checkout signature verification.
- Idempotent wallet settlement from checkout verification and webhooks.
- Subscription lifecycle status, end-of-cycle cancellation, failed-payment state, provider retries, and invoices.

Required backend environment variables: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET. The webhook secret must be a separate random value.

Razorpay account requirements:

1. Enable International Payments so Orders and Plans can use USD.
2. Enable Subscriptions and the required recurring methods.
3. Add a webhook in the matching Test or Live mode at https://YOUR_API_HOST/api/webhooks/razorpay.
4. Use the exact same secret in the dashboard and RAZORPAY_WEBHOOK_SECRET.
5. Subscribe to order.paid, payment.captured, payment.failed, subscription.authenticated, subscription.activated, subscription.charged, subscription.pending, subscription.halted, subscription.cancelled, subscription.completed, invoice.issued, and invoice.paid.

The Enterprise Plan is created lazily on the first subscription attempt and its Plan ID is retained in MongoDB. Credits are recorded only after server verification confirms a captured payment or a signed webhook is processed.