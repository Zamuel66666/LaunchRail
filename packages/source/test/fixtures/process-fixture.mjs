import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode === "flood") {
  process.stdout.write("x".repeat(1024 * 1024));
} else if (mode === "tree") {
  const pidFile = process.argv[3];
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  if (pidFile !== undefined && child.pid !== undefined) {
    writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  }
  setInterval(() => {}, 1000);
}
