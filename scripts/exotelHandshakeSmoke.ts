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
assert.match(resolver.headers.get("content-type") ?? "", /^text\/plain/);
const resolvedUrl = await resolver.text();
const parsedResolvedUrl = new URL(resolvedUrl);
assert.equal(parsedResolvedUrl.origin, `ws://127.0.0.1:${address.port}`);
assert.equal(parsedResolvedUrl.pathname, env.exotelStreamPath);
assert.equal(parsedResolvedUrl.username, "");
assert.equal(parsedResolvedUrl.password, "");
assert.notEqual(parsedResolvedUrl.searchParams.get("token"), env.exotelStreamSecret);
assert.equal([...parsedResolvedUrl.searchParams.keys()].length, 2);

const unauthorizedStatus = await new Promise<number>((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${env.exotelStreamPath}`);
  socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
  socket.on("open", () => reject(new Error("Unauthenticated Exotel socket unexpectedly opened.")));
  socket.on("error", () => undefined);
});
assert.equal(unauthorizedStatus, 401);

await new Promise<void>((resolve, reject) => {
  const socket = new WebSocket(resolvedUrl);
  socket.on("open", () => socket.close(1000, "smoke"));
  socket.on("close", () => resolve());
  socket.on("error", reject);
});

await bridge.close();
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("Exotel resolver and WebSocket authentication smoke test passed.");
