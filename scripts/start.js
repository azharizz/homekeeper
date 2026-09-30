import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.ROOMTRACE_PYTHON || "python3";
const services = {
  capability: [process.execPath, ["capability/server.js"], root],
  roomtrace: [python, ["run.py"], `${root}features/roomtrace`],
  host: [process.execPath, ["alexa_host/server.js"], root],
};
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children.toReversed()) child.kill("SIGTERM");
}
for (const name of process.argv[2]
  ? [process.argv[2]]
  : Object.keys(services)) {
  const [command, args, cwd] = services[name];
  const child = spawn(command, args, { cwd, stdio: "inherit" });
  children.push(child);
  child.on("error", () => {
    console.error(
      `${name} could not start. Check its runtime and .env settings.`,
    );
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
