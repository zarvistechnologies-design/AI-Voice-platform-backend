# Voice quality and latency validation

## Scope of the fixes

- Worker startup reads dispatch job room data before the RTC connection resolves. Connecting to LiveKit and loading authoritative agent configuration can overlap without losing the inbound room name or routing metadata.
- Optional caller history has a wall-clock deadline as well as a MongoDB execution limit. A late result cannot modify the instructions after startup selected its context. Prefetch webhooks have a separate deadline. Required routing and authorization checks are not skipped.
- Turn-taking settings are centralized. The VAD and session use the same effective transport strategy, including Sarvam realtime fallback. These are configuration safeguards, not evidence that every accent or noise condition has been acoustically tested.
- All three browser call surfaces share microphone capture/publication settings and cancellable startup. Permission prompts, token failures, delayed RTC connections, and delayed publications release their resources when the attempt is abandoned.
- Exotel playback clearing uses the agent's interruption signal instead of raw input volume. The chunker preserves a partial final packet with silence padding; the bridge flushes it after a 150 ms input-frame gap or track completion. Interruptions discard the pending tail and its timer.

Exotel documents a minimum 3.2 kB chunk and 320-byte alignment. These constraints are retained; reducing packets below them is not a safe latency optimization. See [Exotel's streaming protocol](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet). At 8 kHz, 3,200 bytes of mono PCM16 represents 200 ms, not 100 ms.

## Repeatable local checks

In `AI-Voice-backend`:

```powershell
npm.cmd test
npm.cmd run test:exotel-bridge
npm.cmd run build
```

In `AI-Voice-platform/frontend`:

```powershell
npm.cmd run test:voice
npm.cmd exec eslint -- src/lib/liveVoiceAudio.ts src/lib/voiceConnection.ts src/lib/voice.ts src/components/dashboard/TestCallPanel.tsx src/app/agents/embedded/EmbeddedVoiceWidget.tsx src/components/sections/IndiaVoiceExperience.tsx test/voiceConnection.test.mjs
npm.cmd run build
```

The frontend tests use Node's built-in TypeScript stripping (Node 22.6+). This local verification used Node 24.16.0; the backend declares Node 22.x, so repeat checks in the production Node 22 environment before release. The frontend test runner can emit a harmless module-type warning without affecting the application bundle.

The tests cover packet sample preservation at 8/16/24 kHz, pending-tail discard, control-message validation, startup metadata selection, optional-context timeouts, and cancellation/resource cleanup. They do not exercise a real microphone, provider connection, carrier jitter, or the bridge timer over a live call.

## Live acceptance checks still required

Use a test agent and approved test caller; do not dial customers for validation. Release the backend API/Exotel bridge and agent worker together because they share the new playback-control message. Release the frontend changes too. No deployment or live calls were performed as part of these local checks.

1. Test dashboard web calls, the embedded widget, and the language demo in Chrome and Safari/mobile. Deny microphone permission, cancel while permission is pending, close during connection, and reconnect. Ended attempts must not reopen the microphone or replace the active call's status.
2. Test browser and each enabled phone transport separately. Verify full greetings and final syllables, short replies such as "yes", names/numbers, natural pauses, and the configured languages.
3. Interrupt during the greeting and mid-reply. The agent should stop promptly, and discarded Exotel audio should not replay. Try speaker echo and quiet/background-noise conditions, including short non-speech sounds. Do not interpret a passing configuration test as proof against false interruptions.
4. Include warm and cold starts and a slower network. Measure at least 20 comparable turns per tested configuration, recording median and p95 caller-end-of-speech to audible-agent-response. Compare with a baseline using the same provider/model, region, prompt, device, and network. Report startup-to-greeting separately from subsequent response latency.
5. Check call records, transcripts, recordings, language fallback, and tool responses. Verify the first/last words in recordings by listening, not just by checking transcript text.

Useful worker logs are `voice-agent-session-ready` (startup stages), `voice-latency-stage` (provider timing), and `voice-first-agent-audio`. The last event measures worker job start to the SDK's first **speaking-state event**, not sound reaching the caller. It includes caller waiting time for user-first agents/outbound calls. Do not report it as end-to-end audible latency.

There is no measured live latency improvement or acoustic-quality score yet. Local tests/builds establish regression coverage, not a guarantee that every production voice issue is resolved.
