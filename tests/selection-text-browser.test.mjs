import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const chromePath = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].find((candidate) => candidate && existsSync(candidate));

test("selected PDF text follows real DOM Range boundaries", {
  skip: chromePath ? false : "Chrome is required for the real DOM regression",
  timeout: 40000,
}, async () => {
  const script = fileURLToPath(new URL("./selection-text-dom.mjs", import.meta.url));
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, CHROME_PATH: chromePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output += chunk; });
  }
  const timer = setTimeout(() => child.kill(), 35000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  clearTimeout(timer);
  assert.equal(exitCode, 0, output);
  assert.match(output, /"sameNode":"DEF"/);
});
