import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// ADR-005: secrets are references, never values. A raw secret in config is a hard error.
const RAW_SECRET = /^(sk_|pk_|ghp_|xox[bp]-)/;

/**
 * Resolve a secret reference to its value at runtime.
 * Supported schemes: env: | file: | keychain: | exec:
 * Rejects inline raw secrets so they never sit in a committed-shaped config.
 */
export function resolveSecret(ref: string): string {
  if (RAW_SECRET.test(ref)) {
    throw new Error(
      "inline secret detected in config; use a reference instead (env:/file:/keychain:/exec:)",
    );
  }

  const idx = ref.indexOf(":");
  if (idx === -1) throw new Error(`not a secret reference: "${ref}" (expected scheme:value)`);
  const scheme = ref.slice(0, idx);
  const value = ref.slice(idx + 1);

  switch (scheme) {
    case "env": {
      const v = process.env[value];
      if (!v) throw new Error(`env var not set: ${value}`);
      return v;
    }
    case "file":
      return readFileSync(value, "utf8").trim();
    case "exec":
      // Unix-friendly: `exec:pass doeh/api`, `exec:op read op://vault/item/field`
      return execSync(value, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    case "keychain":
      return resolveKeychain(value);
    default:
      throw new Error(`unknown secret scheme: ${scheme}`);
  }
}

/** keychain:<service>/<account> — OS keychain lookup. */
function resolveKeychain(ref: string): string {
  const [service, account] = ref.split("/", 2);
  if (!service || !account) throw new Error(`keychain ref must be service/account, got: ${ref}`);
  if (process.platform === "darwin") {
    return execSync(
      `security find-generic-password -s ${shellQuote(service)} -a ${shellQuote(account)} -w`,
      { encoding: "utf8" },
    ).trim();
  }
  if (process.platform === "linux") {
    return execSync(
      `secret-tool lookup service ${shellQuote(service)} account ${shellQuote(account)}`,
      { encoding: "utf8" },
    ).trim();
  }
  throw new Error(`keychain scheme not supported on platform: ${process.platform}`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
