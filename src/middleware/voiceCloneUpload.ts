import multer from "multer";
import { HttpError } from "../utils/httpError.js";

const allowedMimeTypes = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "application/octet-stream",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB max
    files: 5,
  },
  fileFilter: (_request, file, callback) => {
    const mime = file.mimetype.toLowerCase();
    const originalName = file.originalname.toLowerCase();
    const hasAudioExtension = /\.(mp3|wav|m4a|mp4|aac|ogg|webm)$/.test(originalName);

    if (allowedMimeTypes.has(mime) || hasAudioExtension) {
      callback(null, true);
    } else {
      callback(new HttpError(400, "Please upload an audio sample in MP3, WAV, M4A, AAC, OGG, or WEBM format."));
    }
  },
});

// ElevenLabs Instant Voice Cloning accepts multiple reference recordings. Keep
// the legacy `file` field for older clients while the dashboard uses `files`.
export const voiceCloneUpload = upload.fields([
  { name: "files", maxCount: 5 },
  { name: "file", maxCount: 1 },
]);
