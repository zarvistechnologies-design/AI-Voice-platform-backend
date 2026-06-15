import { Router } from "express";

import {
  changePassword,
  disableTwoFactor,
  forgotPassword,
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

export const authRouter = Router();

authRouter.post("/register", asyncHandler(register));
authRouter.post("/login", asyncHandler(login));
authRouter.post("/refresh", asyncHandler(refresh));
authRouter.post("/verify-email", asyncHandler(verifyEmail));
authRouter.post("/forgot-password", asyncHandler(forgotPassword));
authRouter.post("/reset-password", asyncHandler(resetPassword));
authRouter.get("/me", requireAuth, asyncHandler(me));
authRouter.post("/logout", requireAuth, asyncHandler(logout));
authRouter.post("/resend-verification", requireAuth, asyncHandler(resendVerification));
authRouter.post("/change-password", requireAuth, asyncHandler(changePassword));
authRouter.get("/sessions", requireAuth, asyncHandler(listSessions));
authRouter.delete("/sessions/:sessionId", requireAuth, asyncHandler(revokeSession));
authRouter.post("/2fa/setup", requireAuth, asyncHandler(setupTwoFactor));
authRouter.post("/2fa/verify", requireAuth, asyncHandler(verifyTwoFactor));
authRouter.post("/2fa/disable", requireAuth, asyncHandler(disableTwoFactor));
