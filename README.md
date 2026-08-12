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

## Exotel Voicebot

Exotel inbound calls use its bidirectional Voicebot WebSocket protocol instead
of a LiveKit SIP trunk. Configure the deployed API with:

```text
EXOTEL_PUBLIC_BASE_URL=https://api.vozon.ai
EXOTEL_STREAM_SECRET=<long-random-secret>
```

In Exotel's Voicebot applet, select the dynamic HTTP endpoint and enter:

```text
https://api.vozon.ai/api/exotel/voicebot
```

Choose raw, mono, 16-bit PCM at 16 kHz. Import the Exotel number in Vozon and
assign it to a live agent; Exotel's `to` number selects that saved route. The
HTTP endpoint returns a short-lived authenticated `wss://` URL, and the backend bridges
caller audio, agent audio, DTMF, interruption clearing, and stop/disconnect
events. Both the API process and `npm run agent:start` must be running.

Use `npm run test:exotel-bridge` for protocol checks and
`npm run test:exotel-handshake` for resolver/authentication checks.

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

## External API

The external API lets a customer use their own Vozon agents and assigned phone
numbers from another application. Customers authenticate to Vozon only; they
must never receive LiveKit, SIP trunk, AWS, or Vobiz credentials.

### Base URL

Use the Vozon API hostname:

```text
https://api.vozon.ai
```

The examples below use an environment variable so the hostname can be changed
without changing application code:

```bash
export VOZON_API_BASE_URL="https://api.vozon.ai"
export VOZON_API_KEY="avp_REPLACE_WITH_CUSTOMER_KEY"
```

`VOZON_API_BASE_URL` is public. `VOZON_API_KEY` is secret and must only be
stored on the customer's server, secret manager, or protected deployment
environment. It must not be embedded in browser JavaScript, mobile binaries,
public repositories, URLs, or query strings.

### Authentication and scopes

An organization owner or admin creates an API key from the Vozon Developer
dashboard. The full `avp_...` key is returned only when it is created. For the
workflows in this section, create the key with both scopes:

```text
read
calls:trigger
```

Send the key using the standard bearer header:

```http
Authorization: Bearer avp_REPLACE_WITH_CUSTOMER_KEY
```

`X-API-Key: avp_REPLACE_WITH_CUSTOMER_KEY` is also accepted, but the bearer
header is the canonical form used in these examples. Every request is scoped
to the key's organization. A customer cannot access another organization's
agents, numbers, campaigns, leads, calls, recordings, or suppressions.

### Endpoint namespaces

The canonical external call and call-history API is versioned under `/api/v1`.
Campaigns and phone-number discovery currently remain under `/api/voice`; these
routes accept the same `avp_...` API keys and enforce the same organization and
scope checks.

| Purpose | Method and path | Required scope |
| --- | --- | --- |
| List agents | `GET /api/v1/agents` | `read` |
| Start one outbound call | `POST /api/v1/calls/outbound` | `calls:trigger` |
| List calls | `GET /api/v1/calls` | `read` |
| Get one call | `GET /api/v1/calls/:callId` | `read` |
| Stream call-change notifications | `GET /api/v1/calls/stream` | `read` |
| Export calls as CSV | `GET /api/v1/calls/export.csv` | `read` |
| Download a recording | `GET /api/v1/calls/:callId/recording` | `read` |
| List assigned phone numbers | `GET /api/voice/phone-numbers` | `read` |
| List campaigns | `GET /api/voice/campaigns` | `read` |
| Create a campaign | `POST /api/voice/campaigns` | `calls:trigger` |
| Get a campaign | `GET /api/voice/campaigns/:campaignId` | `read` |
| List campaign leads | `GET /api/voice/campaigns/:campaignId/leads` | `read` |
| Add campaign leads | `POST /api/voice/campaigns/:campaignId/leads` | `calls:trigger` |
| Launch a campaign | `POST /api/voice/campaigns/:campaignId/launch` | `calls:trigger` |
| Pause, resume, or cancel | `POST /api/voice/campaigns/:campaignId/:action` | `calls:trigger` |
| List suppressions | `GET /api/voice/campaign-suppressions` | `read` |
| Add a suppression | `POST /api/voice/campaign-suppressions` | `calls:trigger` |

`POST /api/v1/outbound-calls` is a supported alias for
`POST /api/v1/calls/outbound`. `GET /api/v1/call-logs` and
`GET /api/v1/call-logs/:callId` are supported aliases for the call-list and
call-detail endpoints. New integrations should use the canonical paths in the
table.

There is intentionally no `POST /api/v1/calls` route. That path is the call
collection used by `GET /api/v1/calls`. Sending a `POST` to it returns `404`.

### Discover agents and caller IDs

List a compact view of the customer's agents:

```bash
curl "$VOZON_API_BASE_URL/api/v1/agents?view=summary" \
  -H "Authorization: Bearer $VOZON_API_KEY"
```

The `_id` of a returned agent is the `agentId` used in call and campaign
requests. The selected agent must have `status: "Live"` before it can make
calls.

```json
{
  "agents": [
    {
      "_id": "6a45c8ea3b5722d95ca93e5d",
      "name": "Appointment Agent",
      "team": "Scheduling",
      "status": "Live"
    }
  ]
}
```

List the organization's assigned phone numbers:

```bash
curl "$VOZON_API_BASE_URL/api/voice/phone-numbers" \
  -H "Authorization: Bearer $VOZON_API_KEY"
```

The `_id` of a returned number is the `phoneNumberId`. It is not the E.164
phone number, a provider trunk ID, or a LiveKit SIP trunk ID. For outbound use,
the record must be `Ready`, have direction `Outbound` or `Both`, and be
assigned to the selected agent.

```json
{
  "numbers": [
    {
      "_id": "PHONE_NUMBER_OBJECT_ID",
      "number": "+918071578947",
      "direction": "Both",
      "status": "Ready",
      "agentId": {
        "_id": "6a45c8ea3b5722d95ca93e5d",
        "name": "Appointment Agent"
      }
    }
  ]
}
```

### Start a single outbound call

Use this workflow when the customer's system owns the contact list, timing,
retries, and campaign state and wants Vozon to place one call at a time.

```http
POST /api/v1/calls/outbound
```

```bash
curl -X POST "$VOZON_API_BASE_URL/api/v1/calls/outbound" \
  -H "Authorization: Bearer $VOZON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "6a45c8ea3b5722d95ca93e5d",
    "phoneNumberId": "PHONE_NUMBER_OBJECT_ID",
    "phoneNumber": "+919876545336",
    "metadata": {
      "customerName": "Amit",
      "externalCampaignId": "campaign-001",
      "externalLeadId": "lead-001"
    }
  }'
```

Request fields:

| Field | Required | Description |
| --- | --- | --- |
| `agentId` | Yes | Vozon agent `_id`; the agent must be Live. |
| `phoneNumber` | Yes | Destination in E.164 format, such as `+919876543210`. |
| `phoneNumberId` | No | Specific Ready Outbound/Both caller ID assigned to the agent. If omitted, Vozon selects the most recently updated eligible number. |
| `metadata` | No | Up to 50 integration values; keys must begin with a letter and contain only letters, digits, or underscores. String values are limited to 500 characters. |

An accepted call returns HTTP `202`:

```json
{
  "callId": "CALL_OBJECT_ID",
  "roomName": "outbound-call-...",
  "participantId": "PA_...",
  "dispatchId": "AD_..."
}
```

The response means call setup was accepted; the final outcome is available
from call history or webhooks.

### Read call history

List calls:

```bash
curl "$VOZON_API_BASE_URL/api/v1/calls?page=1&limit=20" \
  -H "Authorization: Bearer $VOZON_API_KEY"
```

Supported filters:

| Query parameter | Description |
| --- | --- |
| `page` | Page number, starting at 1. |
| `limit` | Results per page, from 1 through 100. |
| `agentId` | Only calls for one agent. |
| `status` | Only calls with the selected status. |
| `direction` | For example, `inbound`, `outbound`, or `web`. |
| `sentiment` | Match the stored sentiment label. |
| `minDuration` / `maxDuration` | Duration bounds in seconds. |
| `phoneNumber` | Match caller or called number. |
| `search` | Search transcript text, phone numbers, or tags. |
| `from` / `to` | ISO date-time bounds applied to call start time. |

The response includes normalized and compatibility field names, pagination,
agent information, caller/called numbers, status, timestamps, duration,
transcript, recording URL, model usage, cost and billing details, sentiment,
tags, structured output, voicemail detection, and errors.

```json
{
  "calls": [],
  "histories": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "pages": 0
  }
}
```

Get one call:

```bash
curl "$VOZON_API_BASE_URL/api/v1/calls/CALL_OBJECT_ID" \
  -H "Authorization: Bearer $VOZON_API_KEY"
```

Export matching calls as CSV using the same filters:

```bash
curl "$VOZON_API_BASE_URL/api/v1/calls/export.csv?direction=outbound" \
  -H "Authorization: Bearer $VOZON_API_KEY" \
  --output calls.csv
```

Download a recording through an authenticated endpoint:

```bash
curl "$VOZON_API_BASE_URL/api/v1/calls/CALL_OBJECT_ID/recording" \
  -H "Authorization: Bearer $VOZON_API_KEY" \
  --output call-recording.mp3
```

`GET /api/v1/calls/:callId/recording-file` is an alias for the recording
endpoint.

### Stream call-change notifications

`GET /api/v1/calls/stream` is a Server-Sent Events connection. It emits a
`ready` event after connection, `calls_changed` when an organization call is
inserted or updated, and periodic keep-alive comments. The notification is a
signal to fetch the latest call state; it does not contain the full call.

```bash
curl -N "$VOZON_API_BASE_URL/api/v1/calls/stream" \
  -H "Authorization: Bearer $VOZON_API_KEY"
```

Add `?agentId=AGENT_OBJECT_ID` to watch one agent only.

### Vozon-managed campaigns

Use this workflow when Vozon should own lead queuing, calling windows,
scheduling, concurrency, retries, daily limits, DNC enforcement, and campaign
status. After launching a Vozon-managed campaign, the customer must not also
loop over the same leads and call `/api/v1/calls/outbound`.

#### Create a campaign

```http
POST /api/voice/campaigns
```

```bash
curl -X POST "$VOZON_API_BASE_URL/api/voice/campaigns" \
  -H "Authorization: Bearer $VOZON_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: customer-campaign-001" \
  -d '{
    "name": "Patient Follow-up",
    "agentId": "6a45c8ea3b5722d95ca93e5d",
    "phoneNumberId": "PHONE_NUMBER_OBJECT_ID",
    "timezone": "Asia/Kolkata",
    "windowStart": "09:00",
    "windowEnd": "18:00",
    "dailyLimit": 250,
    "concurrency": 3,
    "maxAttempts": 2,
    "retryGapSeconds": 86400,
    "goal": "Schedule an appointment",
    "successCriteria": "The customer confirms an appointment",
    "detectVoicemail": true
  }'
```

The `Idempotency-Key` should be stable for one logical create operation. A
retry with the same key returns the existing campaign instead of creating a
duplicate.

Campaign fields:

| Field | Required | Constraints/default |
| --- | --- | --- |
| `name` | Yes | Campaign display name. |
| `agentId` | Yes | Live agent belonging to the API-key organization. |
| `phoneNumberId` | Yes | Ready Outbound/Both number assigned to that agent. |
| `timezone` | No | Valid IANA timezone; default `UTC`. |
| `windowStart` | No | Local `HH:mm`; default `09:00`. |
| `windowEnd` | No | Local `HH:mm`; default `18:00`. |
| `dailyLimit` | No | Attempts per local day, 1-100000; default 250. |
| `concurrency` | No | 1-100, capped by the agent's maximum; default 3. |
| `maxAttempts` | No | Attempts per lead, 1-10; default 1. |
| `retryGapSeconds` | No | 60-2592000 seconds; default 86400. |
| `goal` | No | Campaign goal, up to 2000 characters. |
| `successCriteria` | No | Success definition, up to 2000 characters. |
| `detectVoicemail` | No | Defaults to `true`. |

Opt-out suppression and a consent opening are mandatory. Requests explicitly
setting `respectDnc` or `requireConsentLine` to `false` are rejected.

#### Upload leads

Leads can only be added while the campaign is a draft. Upload between 1 and
500 rows per request. Phone numbers must use E.164 format. A phone number is
idempotent within a campaign, and an opt-out marker suppresses that lead.

```bash
curl -X POST "$VOZON_API_BASE_URL/api/voice/campaigns/CAMPAIGN_OBJECT_ID/leads" \
  -H "Authorization: Bearer $VOZON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "leads": [
      {
        "phone": "+919876545336",
        "name": "Amit",
        "email": "amit@example.com",
        "company": "Example Company",
        "customFields": {
          "preferredLanguage": "Hindi",
          "appointmentType": "Consultation"
        }
      },
      {
        "phone": "+919812345678",
        "name": "Priya"
      }
    ]
  }'
```

#### Launch now or schedule

Launch immediately:

```bash
curl -X POST "$VOZON_API_BASE_URL/api/voice/campaigns/CAMPAIGN_OBJECT_ID/launch" \
  -H "Authorization: Bearer $VOZON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"now"}'
```

Schedule using an ISO 8601 timestamp:

```bash
curl -X POST "$VOZON_API_BASE_URL/api/voice/campaigns/CAMPAIGN_OBJECT_ID/launch" \
  -H "Authorization: Bearer $VOZON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "schedule",
    "scheduledAt": "2026-08-12T04:30:00.000Z"
  }'
```

Launching is idempotent while a campaign is already scheduled, running, or
paused. The campaign worker checks eligible campaigns every five seconds.

#### Read and control campaigns

```bash
# List campaigns; optional status and limit filters are supported.
curl "$VOZON_API_BASE_URL/api/voice/campaigns?status=running&limit=50" \
  -H "Authorization: Bearer $VOZON_API_KEY"

# Get campaign status and aggregate lead counts.
curl "$VOZON_API_BASE_URL/api/voice/campaigns/CAMPAIGN_OBJECT_ID" \
  -H "Authorization: Bearer $VOZON_API_KEY"

# List leads; page is 1-based, limit is at most 500, and status is optional.
curl "$VOZON_API_BASE_URL/api/voice/campaigns/CAMPAIGN_OBJECT_ID/leads?page=1&limit=100" \
  -H "Authorization: Bearer $VOZON_API_KEY"

# Pause, resume, or cancel.
curl -X POST "$VOZON_API_BASE_URL/api/voice/campaigns/CAMPAIGN_OBJECT_ID/pause" \
  -H "Authorization: Bearer $VOZON_API_KEY"
curl -X POST "$VOZON_API_BASE_URL/api/voice/campaigns/CAMPAIGN_OBJECT_ID/resume" \
  -H "Authorization: Bearer $VOZON_API_KEY"
curl -X POST "$VOZON_API_BASE_URL/api/voice/campaigns/CAMPAIGN_OBJECT_ID/cancel" \
  -H "Authorization: Bearer $VOZON_API_KEY"
```

Campaign statuses are `draft`, `scheduled`, `running`, `paused`, `completed`,
`cancelled`, and `failed`. Lead statuses are `queued`, `leased`, `active`,
`completed`, `retry_wait`, `failed`, `suppressed`, and `cancelled`.

### Do-not-call suppressions

List the organization's suppressions:

```bash
curl "$VOZON_API_BASE_URL/api/voice/campaign-suppressions" \
  -H "Authorization: Bearer $VOZON_API_KEY"
```

Add or update an E.164 number:

```bash
curl -X POST "$VOZON_API_BASE_URL/api/voice/campaign-suppressions" \
  -H "Authorization: Bearer $VOZON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+919876545336",
    "reason": "Customer requested no further calls",
    "source": "crm"
  }'
```

Deleting a suppression requires an API key whose creator still has owner or
admin role:

```bash
curl -X DELETE "$VOZON_API_BASE_URL/api/voice/campaign-suppressions/SUPPRESSION_OBJECT_ID" \
  -H "Authorization: Bearer $VOZON_API_KEY"
```

### API errors

Errors use JSON with a customer-safe message and request ID:

```json
{
  "message": "Description of the error.",
  "requestId": "request-correlation-id"
}
```

Common status codes:

| Status | Meaning |
| --- | --- |
| `400` | Invalid body, identifier, phone format, date, or campaign setting. |
| `401` | Missing, invalid, expired, or revoked API key. |
| `402` | Insufficient Vozon wallet credits to start a call. |
| `403` | API key lacks the required scope or organization role. |
| `404` | Route or organization-scoped resource was not found. |
| `409` | Agent, caller ID, campaign, call window, or concurrent state is not eligible. |
| `429` | Agent or organization call capacity has been reached. |
| `503` | LiveKit, SIP trunk, provider, or outbound routing is unavailable. |

Log the returned `requestId` with the customer's own operation ID. Never retry
all errors blindly: retry transient `429` and `503` responses with bounded
exponential backoff, use the same campaign `Idempotency-Key` when retrying
campaign creation, and correct `400`, `401`, `403`, or `404` responses before
retrying.

### Recommended integration variables

For a customer application that uses both Vozon-managed campaigns and single
outbound calls:

```env
VOZON_API_BASE_URL=https://api.vozon.ai
VOZON_API_KEY=avp_REPLACE_WITH_CUSTOMER_KEY
VOZON_CAMPAIGN_URL=https://api.vozon.ai/api/voice/campaigns
VOZON_OUTBOUND_CALL_URL=https://api.vozon.ai/api/v1/calls/outbound
```

Do not configure `VOZON_OUTBOUND_CALL_URL` as `/api/v1/calls`; that collection
path supports `GET`, not `POST`.

Each user connects their own Vobiz account from the phone-number dashboard.
Provider tokens are encrypted at rest, scoped by user ID, and never returned to
the browser after connection. Vobiz owns, sells, and bills the phone number;
Vobiz hands inbound PSTN calls to `LIVEKIT_SIP_URI` (or the LiveKit Cloud SIP
host inferred from `LIVEKIT_URL`), and LiveKit SIP dispatch rules connect those
inbound numbers to the selected AI agent.
During import, purchase, or route sync, Vozon also applies the configured
`VOBIZ_INBOUND_TRUNK_NAME` and `VOBIZ_OUTBOUND_TRUNK_NAME` display names to
the Vobiz/LiveKit trunks it manages. Existing legacy `LiveKit ...` trunk names
are migrated automatically during the next sync.

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
