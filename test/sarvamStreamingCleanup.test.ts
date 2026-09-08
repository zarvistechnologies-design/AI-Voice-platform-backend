import assert from "node:assert/strict";
import test from "node:test";
import { SynthesizeStream } from "@livekit/agents-plugin-sarvam";

class SocketProbe {
  closes = 0;
  terminations = 0;
  constructor(public readyState: number) {}
  send() { throw new Error("Cleanup must not synthesize or flush more audio"); }
  close() { this.closes += 1; }
  terminate() { this.terminations += 1; }
}

// Exercise the installed, patched provider method without opening a connection.
const closeWebSocket = (SynthesizeStream.prototype as unknown as {
  closeWebSocket(this: { abortController: AbortController }, socket: SocketProbe): Promise<void>;
}).closeWebSocket;

test("completed Sarvam synthesis closes without a second flush or server acknowledgement", { timeout: 500 }, async () => {
  const socket = new SocketProbe(1);
  await closeWebSocket.call({ abortController: new AbortController() }, socket);
  assert.equal(socket.closes, 1);
  assert.equal(socket.terminations, 0, "normal completion uses a graceful close");
});

test("interrupted Sarvam synthesis discards its open transport immediately", { timeout: 500 }, async () => {
  for (const readyState of [0, 1]) {
    const socket = new SocketProbe(readyState);
    const abortController = new AbortController();
    abortController.abort();
    await closeWebSocket.call({ abortController }, socket);
    assert.equal(socket.closes, 0);
    assert.equal(socket.terminations, 1);
  }
});

test("Sarvam cleanup is harmless when the socket is closing or already closed", async () => {
  for (const readyState of [2, 3]) {
    const socket = new SocketProbe(readyState);
    await closeWebSocket.call({ abortController: new AbortController() }, socket);
    assert.equal(socket.closes + socket.terminations, 0);
  }
});
