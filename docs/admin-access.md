# Platform admin access

The account and payment panel is at `/admin`. Use `/login?next=/admin` for the admin sign-in form. Admin access requires all of the following for the same account:

1. A registered account with a verified email address and password.
2. Two-factor authentication enabled in **Dashboard → Profile → Two-factor authentication**.
3. A `super_admin` database role assigned by an operator.
4. The account email in the backend's `PLATFORM_ADMIN_EMAILS` environment variable (comma-separated, exact addresses). An empty list disables admin access.
5. A current interactive session signed in with the account password and authenticator code. The authenticator proof expires for admin routes after 12 hours; sign out and sign in again to renew it.

After the owner completes steps 1 and 2, set `PLATFORM_ADMIN_EMAILS` in the production backend environment and restart/redeploy the backend. Then run:

```sh
npm run admin:set-role -- --email=owner@example.com --role=super_admin --confirm
```

The command refuses to promote an account without a verified email, password, authenticator, or allowlist entry. Never store a password, recovery code, or authenticator seed in environment variables, source control, or chat. Admin API routes reject API keys and sessions that did not prove the authenticator code.
