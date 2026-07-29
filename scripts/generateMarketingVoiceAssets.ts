import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const samples = {
  hi: { language: "hi-IN", text: "नमस्ते! मैं आपकी कैसे मदद कर सकती हूँ?" },
  en: { language: "en-IN", text: "Hello! How can I help you today?" },
  ta: { language: "ta-IN", text: "வணக்கம்! நான் உங்களுக்கு எப்படி உதவலாம்?" },
  te: { language: "te-IN", text: "నమస్తే! నేను మీకు ఎలా సహాయం చేయగలను?" },
  kn: { language: "kn-IN", text: "ನಮಸ್ಕಾರ! ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?" },
  mr: { language: "mr-IN", text: "नमस्कार! मी तुम्हाला कशी मदत करू शकते?" },
  bn: { language: "bn-IN", text: "নমস্কার! আমি আপনাকে কীভাবে সাহায্য করতে পারি?" },
  gu: { language: "gu-IN", text: "નમસ્તે! હું તમને કેવી રીતે મદદ કરી શકું?" },
  pa: { language: "pa-IN", text: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ?" },
  ml: { language: "ml-IN", text: "നമസ്കാരം! എനിക്ക് നിങ്ങളെ എങ്ങനെ സഹായിക്കാം?" },
} as const;

const apiKey = process.env.SARVAM_API_KEY?.trim();
if (!apiKey) throw new Error("SARVAM_API_KEY is required.");

const outputDirectory = path.resolve(
  process.cwd(),
  "../AI-Voice-platform-main/frontend/public/audio/india-voices",
);
await mkdir(outputDirectory, { recursive: true });

for (const [code, sample] of Object.entries(samples)) {
  const response = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": apiKey,
    },
    body: JSON.stringify({
      text: sample.text,
      target_language_code: sample.language,
      speaker: "kavya",
      model: "bulbul:v3",
      pace: 0.96,
      speech_sample_rate: "24000",
      output_audio_codec: "wav",
    }),
  });

  const payload = await response.json() as { audios?: string[]; error?: { message?: string } };
  const encodedAudio = payload.audios?.[0];
  if (!response.ok || !encodedAudio) {
    throw new Error(payload.error?.message || `Voice generation failed for ${code}: ${response.status}`);
  }

  const audio = Buffer.from(encodedAudio, "base64");
  if (audio.subarray(0, 4).toString("ascii") !== "RIFF") {
    throw new Error(`Voice generation returned invalid WAV data for ${code}.`);
  }
  await writeFile(path.join(outputDirectory, `${code}.wav`), audio);
  console.log(`${code}: ${audio.byteLength} bytes`);
}
