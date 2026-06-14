import cors from "cors";
import express from "express";

import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/authRoutes.js";
import { voiceRouter } from "./routes/voiceRoutes.js";

export const app = express();

app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
  }),
);
app.use(express.json());

app.get("/health", (_request, response) => {
  response.status(200).json({
    status: "ok",
    service: "ai-voice-platform-backend",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/voice", voiceRouter);

app.use(notFoundHandler);
app.use(errorHandler);
