import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";

const path = new URL("../.env", import.meta.url);
let original = existsSync(path) ? readFileSync(path, "utf8") : "";
const values = parseEnv(original);
const defaults = {
  LOCAL_HOST_PORT: "8789",
  NEBIUS_MODEL: "",
  NEBIUS_API_KEY: "",
  NEBIUS_BASE_URL: "",
  HOMEKEEPER_TOKEN: randomBytes(32).toString("hex"),
  MCP_REQUEST_TIMEOUT_MS: "900000",
  MAX_AGENT_ROUNDS: "12",
};
const emptyToken = "HOMEKEEPER_TOKEN" in values && !values.HOMEKEEPER_TOKEN;
if (emptyToken) {
  original = original.replace(
    /^(?:export[ \t]+)?HOMEKEEPER_TOKEN[ \t]*=.*$/m,
    `HOMEKEEPER_TOKEN=${defaults.HOMEKEEPER_TOKEN}`,
  );
}
const additions = Object.entries(defaults)
  .filter(([key]) => !(key in values))
  .map(([key, value]) => `${key}=${value}`);
if (additions.length || emptyToken)
  writeFileSync(
    path,
    `${original}${original.endsWith("\n") || !original ? "" : "\n"}${additions.join("\n")}\n`,
    { mode: 0o600 },
  );
chmodSync(path, 0o600);
console.log("Local configuration prepared. Existing values were preserved.");
console.log(
  ["NEBIUS_MODEL", "NEBIUS_API_KEY", "NEBIUS_BASE_URL"].every(
    (key) => values[key],
  )
    ? "Nebius configuration is present."
    : "Add the three Nebius values to .env to enable conversation. No key is printed.",
);
