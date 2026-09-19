import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { invalidateElevenLabsVoiceCache, elevenLabsVoiceProfile } from "../services/modelCatalog.js";
import { invalidateDashboardCache } from "../services/dashboardCacheService.js";

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

export async function cloneElevenLabsVoice(request: AuthenticatedRequest, response: Response) {
  if (!env.elevenLabsApiKey) {
    throw new HttpError(503, "ElevenLabs is not configured on this platform. Please set ELEVENLABS_API_KEY.");
  }

  const name = cleanText(request.body.name);
  if (!name || name.length < 2) {
    throw new HttpError(400, "Please provide a voice name with at least 2 characters.");
  }
  if (name.length > 100) {
    throw new HttpError(400, "Voice name must be 100 characters or fewer.");
  }

  if (request.body.confirmRights !== "true") {
    throw new HttpError(400, "Confirm that you have permission to clone and use this voice.");
  }

  const uploaded = (request as unknown as {
    files?: Record<string, Express.Multer.File[]> | Express.Multer.File[];
  }).files;
  const files = (Array.isArray(uploaded)
    ? uploaded
    : [...(uploaded?.files ?? []), ...(uploaded?.file ?? [])])
    .filter((file) => file.buffer?.byteLength > 0)
    .slice(0, 5);
  if (files.length === 0) {
    throw new HttpError(400, "Please upload or record an audio sample for voice cloning.");
  }

  const description = cleanText(request.body.description).slice(0, 500);
  let labels: Record<string, string> = {};
  if (typeof request.body.labels === "string") {
    try {
      labels = JSON.parse(request.body.labels);
    } catch {
      labels = {};
    }
  } else if (typeof request.body.labels === "object" && request.body.labels !== null) {
    labels = request.body.labels as Record<string, string>;
  }

  if (request.body.gender && typeof request.body.gender === "string") {
    labels.gender = cleanText(request.body.gender);
  }
  if (request.body.accent && typeof request.body.accent === "string") {
    labels.accent = cleanText(request.body.accent);
  }

  const formData = new FormData();
  formData.append("name", name);
  if (description) {
    formData.append("description", description);
  }
  if (Object.keys(labels).length > 0) {
    formData.append("labels", JSON.stringify(labels));
  }
  formData.append(
    "remove_background_noise",
    request.body.removeBackgroundNoise === "true" ? "true" : "false",
  );

  for (const [index, file] of files.entries()) {
    const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "audio/mpeg" });
    formData.append("files", blob, file.originalname || `voice_sample_${index + 1}.mp3`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    const apiResponse = await fetch("https://api.elevenlabs.io/v1/voices/add", {
      method: "POST",
      headers: {
        "xi-api-key": env.elevenLabsApiKey,
      },
      body: formData,
      signal: controller.signal,
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text().catch(() => "");
      let errorMessage = "Could not clone voice with ElevenLabs.";
      try {
        const errorJson = JSON.parse(errorText) as { detail?: { message?: string } | string };
        if (typeof errorJson.detail === "string") {
          errorMessage = errorJson.detail;
        } else if (errorJson.detail?.message) {
          errorMessage = errorJson.detail.message;
        }
      } catch {
        if (errorText.length > 0 && errorText.length < 200) {
          errorMessage = errorText;
        }
      }
      throw new HttpError(apiResponse.status === 401 || apiResponse.status === 403 ? 503 : 400, errorMessage);
    }

    const payload = (await apiResponse.json()) as {
      voice_id?: string;
      requires_verification?: boolean;
    };
    const voiceId = payload.voice_id?.trim();
    if (!voiceId) {
      throw new HttpError(502, "ElevenLabs created the voice but did not return a voice ID.");
    }

    // Invalidate local voice cache so next fetch includes this newly cloned voice
    invalidateElevenLabsVoiceCache();
    if (request.organization?.id) {
      await invalidateDashboardCache(request.organization.id);
    }

    const createdVoice = {
      voice_id: voiceId,
      name,
      category: "cloned",
      description,
      labels,
    };

    const profile = elevenLabsVoiceProfile(createdVoice) ?? {
      value: voiceId,
      label: name,
      category: "cloned",
      qualityTier: "Instant Voice Clone",
      source: "Custom Cloned Voice",
      ...(labels.gender ? { gender: labels.gender.toLowerCase() as "male" | "female" } : {}),
      ...(labels.accent ? { accent: labels.accent } : {}),
      ...(description ? { note: description } : {}),
    };

    response.status(201).json({
      success: true,
      voiceId,
      name,
      category: "cloned",
      requiresVerification: payload.requires_verification === true,
      profile,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "Voice cloning request timed out with ElevenLabs.");
    }
    throw new HttpError(500, error instanceof Error ? error.message : "Failed to clone voice.");
  } finally {
    clearTimeout(timeout);
  }
}
