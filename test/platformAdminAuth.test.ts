import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Response } from "express";

import { requirePlatformRole, type AuthenticatedRequest } from "../src/middleware/auth.js";

function adminAccess(overrides: Partial<AuthenticatedRequest> = {}) {
  const request = {
    user: { id: "user", email: "admin@example.com", name: "Admin", emailVerified: true, twoFactorEnabled: true, platformRole: "super_admin" },
    platformRole: "super_admin",
    sessionId: "session",
    mfaVerifiedAt: new Date(),
    ...overrides,
  } as AuthenticatedRequest;
  let outcome: unknown = "not-called";
  requirePlatformRole("super_admin")(request, {} as Response, ((error?: unknown) => { outcome = error ?? "allowed"; }) as NextFunction);
  return outcome;
}

test("platform admin access requires a recent authenticator-verified interactive session", () => {
  assert.equal(adminAccess(), "allowed");
  for (const override of [
    { apiKey: { id: "key", scopes: ["full-access"], workspaceAccess: "own" } },
    { sessionId: undefined },
    { mfaVerifiedAt: undefined },
    { mfaVerifiedAt: new Date(Date.now() - 13 * 60 * 60 * 1000) },
    { user: { id: "user", email: "admin@example.com", name: "Admin", emailVerified: false, twoFactorEnabled: true, platformRole: "super_admin" } },
    { user: { id: "user", email: "admin@example.com", name: "Admin", emailVerified: true, twoFactorEnabled: false, platformRole: "super_admin" } },
    { platformRole: "user" },
  ] as Partial<AuthenticatedRequest>[]) {
    assert.ok(adminAccess(override) instanceof Error);
  }
});
