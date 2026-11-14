import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join("test", name));
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(process.execPath, [tsx, "--test", "--test-concurrency=4", ...files], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, REDIS_URL: "" },
});

child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
