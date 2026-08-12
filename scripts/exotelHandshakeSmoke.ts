import assert from "node:assert/strict";
import { createServer } from "node:http";

import WebSocket from "ws";

import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { attachExotelVoicebotServer } from "../src/services/exotelVoicebotService.js";

env.exotelPublicBaseUrl = "";
env.exotelResolverPath = "/api/exotel/voicebot";
env.exotelStreamPath = "/api/exotel/voicebot/stream";
env.exotelStreamSecret = "exotel-smoke-secret";
env.exotelStreamConfigured = true;

const server = createServer(app);
const bridge = attachExotelVoicebotServer(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;

const resolver = await fetch(`${baseUrl}${env.exotelResolverPath}`);
assert.equal(resolver.status, 200);
const body = await resolver.json() as { url?: string };
assert.ok(body.url?.startsWith(`ws://127.0.0.1:${address.port}${env.exotelStreamPath}`));
assert.notEqual(new URL(body.url).searchParams.get("token"), env.exotelStreamSecret);
assert.ok(new URL(body.url).searchParams.get("expires"));

const unauthorizedStatus = await new Promise<number>((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${env.exotelStreamPath}`);
  socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
  socket.on("open", () => reject(new Error("Unauthenticated Exotel socket unexpectedly opened.")));
  socket.on("error", () => undefined);
});
assert.equal(unauthorizedStatus, 401);

await new Promise<void>((resolve, reject) => {
  const socket = new WebSocket(body.url!);
  socket.on("open", () => socket.close(1000, "smoke"));
  socket.on("close", () => resolve());
  socket.on("error", reject);
});

await bridge.close();
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("Exotel resolver and WebSocket authentication smoke test passed.");
