import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual socket lifecycle without creating servers, RTC or paid calls.
const source = ts.createSourceFile("bridge.ts", readFileSync(
  new URL("../src/services/exotelVoicebotService.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);
const lifecycle = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "handleVoicebotSocket",
)!;
const code = ts.transpileModule(lifecycle.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class Socket extends EventEmitter {
  readyState = 1;
  close() { this.readyState = 3; this.emit("close"); }
  message(event: object) { this.emit("message", JSON.stringify(event), false); }
}

function setup(createRuntime: () => Promise<unknown>) {
  let closed = 0;
  let failed = 0;
  const context = vm.createContext({
    console: { log() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {},
    START_EVENT_TIMEOUT_MS: 1000, MAX_STREAM_DURATION_MS: 1000,
    WebSocket: { OPEN: 1 },
    createBridgeRuntime: createRuntime,
    closeBridgeRuntime: async () => { closed += 1; },
    failCall: async () => { failed += 1; },
    parseExotelStreamEvent: JSON.parse, rawDataText: String,
    decodeExotelPcm: () => new Int16Array(160),
    AudioFrame: class {},
  });
  vm.runInContext(code, context);
  const socket = new Socket();
  context.socket = socket;
  vm.runInContext("handleVoicebotSocket(socket)", context);
  return { socket, closed: () => closed, failed: () => failed };
}

test("Exotel stop bypasses blocked media and ignores expected capture rejection", async () => {
  let rejectCapture!: (error: Error) => void;
  const capture = new Promise<void>((_, reject) => { rejectCapture = reject; });
  let captures = 0;
  const probe = setup(async () => ({ audioSource: { captureFrame: () => { captures += 1; return capture; } } }));
  probe.socket.message({ event: "start" });
  await tick();
  probe.socket.message({ event: "media", media: { payload: "audio" } });
  probe.socket.message({ event: "media", media: { payload: "queued" } });
  await tick();
  assert.equal(captures, 1);
  probe.socket.message({ event: "stop" });
  assert.equal(probe.closed(), 1, "must close without waiting for media");
  rejectCapture(new Error("audio source closed"));
  await tick();
  assert.equal(captures, 1, "queued audio is discarded");
  assert.equal(probe.failed(), 0, "normal hang-up is not a failed call");
});

test("Exotel setup completing after hang-up is cleaned up exactly once", async () => {
  let finishSetup!: (runtime: object) => void;
  const probe = setup(() => new Promise((resolve) => { finishSetup = resolve; }));
  probe.socket.message({ event: "start" });
  await tick();
  probe.socket.close();
  assert.equal(probe.closed(), 0);
  finishSetup({});
  await tick();
  assert.equal(probe.closed(), 1);
  probe.socket.close();
  await tick();
  assert.equal(probe.closed(), 1);
});

test("Exotel socket disconnect bypasses blocked media", async () => {
  let finishCapture!: () => void;
  const capture = new Promise<void>((resolve) => { finishCapture = resolve; });
  const probe = setup(async () => ({ audioSource: { captureFrame: () => capture } }));
  probe.socket.message({ event: "start" });
  await tick();
  probe.socket.message({ event: "media", media: { payload: "audio" } });
  await tick();
  probe.socket.close();
  assert.equal(probe.closed(), 1);
  finishCapture();
  await tick();
});
