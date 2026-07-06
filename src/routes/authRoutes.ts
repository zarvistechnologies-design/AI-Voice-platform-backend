import { Router } from "express";

import {
  changePassword,
  disableTwoFactor,
  forgotPassword,
  googleLogin,
  listSessions,
  login,
  logout,
  me,
  refresh,
  register,
  resendVerification,
  resetPassword,
  revokeSession,
  setupTwoFactor,
  verifyEmail,
  verifyTwoFactor,
} from "../controllers/authController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rateLimit.js";

export const authRouter = Router();

const authAttemptLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many authentication attempts. Try again later.",
});
const authRecoveryLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many account recovery attempts. Try again later.",
});

authRouter.post("/register", authAttemptLimit, asyncHandler(register));
authRouter.post("/login", authAttemptLimit, asyncHandler(login));
authRouter.post("/google", authAttemptLimit, asyncHandler(googleLogin));
authRouter.post("/refresh", authAttemptLimit, asyncHandler(refresh));
authRouter.post("/verify-email", asyncHandler(verifyEmail));
authRouter.post("/forgot-password", authRecoveryLimit, asyncHandler(forgotPassword));
authRouter.post("/reset-password", authRecoveryLimit, asyncHandler(resetPassword));
authRouter.get("/me", requireAuth, asyncHandler(me));
authRouter.post("/logout", requireAuth, asyncHandler(logout));
authRouter.post("/resend-verification", requireAuth, asyncHandler(resendVerification));
authRouter.post("/change-password", requireAuth, asyncHandler(changePassword));
authRouter.get("/sessions", requireAuth, asyncHandler(listSessions));
authRouter.delete("/sessions/:sessionId", requireAuth, asyncHandler(revokeSession));
authRouter.post("/2fa/setup", requireAuth, asyncHandler(setupTwoFactor));
authRouter.post("/2fa/verify", requireAuth, asyncHandler(verifyTwoFactor));
authRouter.post("/2fa/disable", requireAuth, asyncHandler(disableTwoFactor));
