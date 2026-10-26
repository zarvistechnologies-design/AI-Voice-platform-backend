# Integration setup

The Integrations page connects third-party accounts directly to a Vozon workspace. It does not require an MCP server. Credentials and OAuth tokens are encrypted per workspace. Connecting an account permits read-only previews in the dashboard and Ask Vozon. Voice agents can read a provider only after an owner or admin enables **Voice agent access** for that agent on the provider card.

## OAuth applications required for production

Configure these values in the backend environment, including the Render service if that is where the backend runs. Register each callback URL exactly as configured with the provider. The callback origin must be the public backend origin that serves `/api/integrations`; it may differ from the frontend URL.

| Provider | Backend environment values | Registered callback path |
| --- | --- | --- |
| Zoho CRM | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_OAUTH_REDIRECT_URI` | `/api/integrations/zoho/callback` |
| Salesforce | `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_OAUTH_REDIRECT_URI` | `/api/integrations/salesforce/callback` |
| Razorpay OAuth | `RAZORPAY_OAUTH_CLIENT_ID`, `RAZORPAY_OAUTH_CLIENT_SECRET`, `RAZORPAY_OAUTH_REDIRECT_URI` | `/api/integrations/razorpay_oauth/callback` |

For Razorpay OAuth test mode, also configure the development client's `RAZORPAY_OAUTH_TEST_CLIENT_ID` and `RAZORPAY_OAUTH_TEST_CLIENT_SECRET`. A production client cannot authorize test-mode data.

Create a Zoho server-based OAuth client with CRM user and module read scopes. Create a Salesforce External Client App with the authorization-code flow, API access, refresh-token access, and identity scope. Razorpay OAuth requires platform-partner approval and an OAuth application; it is separate from the customer-owned Razorpay API-key connector. Without these application credentials the corresponding cards show **Setup needed** and the API returns a clear configuration error.

Google Calendar and Sheets use the existing Google OAuth application. Drive, Docs, and Gmail ask for their additional read scopes when their individual cards are connected. Add those scopes to the Google OAuth app consent configuration before using them in production. The customer must consent to each feature.

## Customer-provided connections

Asana, ClickUp, Linear, monday.com, Notion, Atlassian, Jira, Freshsales, GoHighLevel, and Razorpay API accept customer-owned tokens or keys on their cards. Atlassian and Jira need a Cloud site, account email, and API token. Freshsales needs its site and API key. GoHighLevel needs a Location ID and a scoped Private Integration Token. Razorpay API needs a merchant Key ID and Key Secret. Vozon verifies the credential with a bounded read before storing it.

Zapier uses a customer-created Catch Hook URL through the outbound webhook configuration on the Developers page. Slack uses a customer-created incoming webhook. HubSpot, Calendly, Vobiz, and WhatsApp retain their existing workflows.

## Verification limits

The contract tests mock provider replies for the new connectors and cover authorization requests, credential checks, bounded previews, OAuth tenant binding, and encrypted token storage. Google Calendar/Sheets and Vobiz were also exercised with the accounts already connected in the local test workspace. A live authorization and preview for each additional provider requires a customer or test account. The Vozon OAuth applications and partner approval must exist before their live authorization flows can pass.
