/**
 * Records the exact toolchain, dependency, and upstream-source versions this
 * repository is currently built with, into artifacts/source-lock/version-report.json.
 *
 * Every value is read from a live command, a lockfile, or a pinned manifest. Nothing
 * is hardcoded from memory. A field this script cannot establish is written as null
 * with a reason, never as a plausible-looking version string.
 *
 * Idempotent: running it twice without changing the environment produces a report
 * whose only difference is `captured_at`. `--check` asserts that.
 *
 *   pnpm source-lock
 *   pnpm source-lock -- --check
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "source-lock");
const REPORT_PATH = join(ARTIFACT_DIR, "version-report.json");
const SOLANA_BIN = join(REPO_ROOT, ".toolchain", "solana", "active_release", "bin");

/** Upstream sources the PRD and implementation are pinned to. */
const PINNED_SOURCES = {
  magicblock_dev_skill: {
    repository: "https://github.com/magicblock-labs/magicblock-dev-skill",
    installed_at: ".claude/skills/magicblock",
  },
  solana_dev_skill: {
    repository: "https://github.com/solana-foundation/solana-dev-skill",
    installed_at: ".claude/skills/solana-dev",
  },
  magicblock_engine_examples: {
    repository: "https://github.com/magicblock-labs/magicblock-engine-examples",
    installed_at: null,
  },
} as const;

type Unresolved = { value: null; reason: string };
type Resolved<T> = { value: T; source: string };
type Field<T> = Resolved<T> | Unresolved;

function unresolved(reason: string): Unresolved {
  return { value: null, reason };
}

function run(command: string, args: readonly string[], cwd = REPO_ROOT): string | null {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
      env: { ...process.env, PATH: `${SOLANA_BIN}:${process.env.PATH ?? ""}` },
    }).trim();
  } catch {
    return null;
  }
}

function version(
  command: string,
  args: readonly string[],
  pick: (out: string) => string,
): Field<string> {
  const out = run(command, args);
  if (out === null)
    return unresolved(`\`${command} ${args.join(" ")}\` failed or is not installed`);
  const picked = pick(out);
  if (!picked) return unresolved(`could not parse version from \`${command} ${args.join(" ")}\``);
  return { value: picked, source: `${command} ${args.join(" ")}` };
}

const firstSemver = (out: string): string => out.match(/\d+\.\d+\.\d+[^\s)]*/)?.[0] ?? "";

/**
 * Resolves the upstream commit an installed skill came from.
 *
 * The skill installers copy files rather than cloning, so there is no .git to read.
 * Installation therefore writes a `.source-lock.json` pin next to the skill, and that
 * pin is the record. A skill without one is reported unresolved, never guessed.
 */
function skillCommit(path: string): Field<string> {
  const pinPath = join(REPO_ROOT, path, ".source-lock.json");
  if (!existsSync(pinPath)) {
    return unresolved(`no ${path}/.source-lock.json; reinstall the skill and record its commit`);
  }
  try {
    const pin = JSON.parse(readFileSync(pinPath, "utf8")) as { commit?: unknown };
    if (typeof pin.commit !== "string" || !/^[0-9a-f]{40}$/.test(pin.commit)) {
      return unresolved(`${path}/.source-lock.json has no 40-character commit`);
    }
    return { value: pin.commit, source: `${path}/.source-lock.json` };
  } catch {
    return unresolved(`${path}/.source-lock.json is not valid JSON`);
  }
}

/** Reads a resolved dependency version out of the committed Cargo.lock. */
function cargoLockVersion(crate: string): Field<string> {
  const lockPath = join(REPO_ROOT, "Cargo.lock");
  if (!existsSync(lockPath)) return unresolved("Cargo.lock not present");
  const lock = readFileSync(lockPath, "utf8");
  const matcher = new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`);
  const found = lock.match(matcher);
  return found?.[1]
    ? { value: found[1], source: "Cargo.lock" }
    : unresolved(`${crate} not present in Cargo.lock`);
}

/** Reads the exact pinned version from package.json, which uses no ranges. */
function npmPin(pkg: string): Field<string> {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const pinned = manifest.dependencies?.[pkg] ?? manifest.devDependencies?.[pkg];
  if (!pinned) return unresolved(`${pkg} is not a dependency`);
  if (/[\^~*><]/.test(pinned))
    return unresolved(`${pkg} is pinned to a range (${pinned}), not an exact version`);
  return { value: pinned, source: "package.json" };
}

function envEndpoint(name: string, fallback: string): Resolved<string> {
  return {
    value: process.env[name] ?? fallback,
    source: process.env[name] ? `env:${name}` : "scripts/toolchain-env.sh",
  };
}

/**
 * The engine examples are inspected, not vendored. The commit that was inspected is
 * recorded in a pin file so this report never depends on a remembered SHA.
 */
function readEngineExamplesPin(): Field<string> {
  const pinPath = join(REPO_ROOT, "docs", "upstream-pins.json");
  if (!existsSync(pinPath)) return unresolved("docs/upstream-pins.json is missing");
  try {
    const pin = JSON.parse(readFileSync(pinPath, "utf8")) as Record<string, { commit?: unknown }>;
    const commit = pin.magicblock_engine_examples?.commit;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
      return unresolved("docs/upstream-pins.json has no 40-character engine-examples commit");
    }
    return { value: commit, source: "docs/upstream-pins.json" };
  } catch {
    return unresolved("docs/upstream-pins.json is not valid JSON");
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");

  const report = {
    captured_at: new Date().toISOString(),
    repository_commit: run("git", ["rev-parse", "HEAD"]) ?? null,
    repository_dirty: (run("git", ["status", "--porcelain"]) ?? "") !== "",

    upstream_sources: {
      magicblock_dev_skill: {
        ...PINNED_SOURCES.magicblock_dev_skill,
        commit: skillCommit(PINNED_SOURCES.magicblock_dev_skill.installed_at),
      },
      solana_dev_skill: {
        ...PINNED_SOURCES.solana_dev_skill,
        commit: skillCommit(PINNED_SOURCES.solana_dev_skill.installed_at),
      },
      magicblock_engine_examples: {
        ...PINNED_SOURCES.magicblock_engine_examples,
        commit: readEngineExamplesPin(),
      },
    },

    toolchain: {
      rustc: version("rustc", ["--version"], firstSemver),
      cargo: version("cargo", ["--version"], firstSemver),
      rustup: version("rustup", ["--version"], firstSemver),
      solana_cli: version(join(SOLANA_BIN, "solana"), ["--version"], firstSemver),
      cargo_build_sbf: version(join(SOLANA_BIN, "cargo-build-sbf"), ["--version"], firstSemver),
      platform_tools: version(
        join(SOLANA_BIN, "cargo-build-sbf"),
        ["--version"],
        (out) => out.match(/platform-tools v([\d.]+)/)?.[1] ?? "",
      ),
      anchor_cli: version("anchor", ["--version"], firstSemver),
      node: version("node", ["--version"], firstSemver),
      pnpm: version("pnpm", ["--version"], firstSemver),
    },

    rust_dependencies: {
      anchor_lang: cargoLockVersion("anchor-lang"),
      ephemeral_rollups_sdk: cargoLockVersion("ephemeral-rollups-sdk"),
      magicblock_magic_program_api: cargoLockVersion("magicblock-magic-program-api"),
      magicblock_delegation_program_api: cargoLockVersion("magicblock-delegation-program-api"),
      solana_program: cargoLockVersion("solana-program"),
    },

    typescript_dependencies: {
      coral_anchor: npmPin("@coral-xyz/anchor"),
      ephemeral_rollups_sdk: npmPin("@magicblock-labs/ephemeral-rollups-sdk"),
      ephemeral_validator: npmPin("@magicblock-labs/ephemeral-validator"),
      magic_router_sdk: npmPin("magic-router-sdk"),
      solana_web3js: npmPin("@solana/web3.js"),
      typescript: npmPin("typescript"),
    },

    endpoints: {
      local_base_rpc: envEndpoint("VINCT_BASE_RPC", "http://127.0.0.1:8899"),
      local_er_rpc: envEndpoint("VINCT_ER_RPC", "http://127.0.0.1:7799"),
      local_qfs_rpc: envEndpoint("VINCT_QFS_RPC", "http://127.0.0.1:6699"),
      devnet_base_rpc: envEndpoint("VINCT_DEVNET_BASE_RPC", "https://rpc.magicblock.app/devnet"),
      devnet_router: envEndpoint("VINCT_DEVNET_ROUTER", "https://devnet-router.magicblock.app/"),
      status_api: envEndpoint("VINCT_STATUS_API", "https://status.magicblock.app/api/services"),
      resolved_er_endpoint: unresolved(
        "resolved per account at runtime through router getDelegationStatus; never pinned",
      ),
    },

    status_api_snapshot: existsSync(join(ARTIFACT_DIR, "magicblock-status-devnet-latest.json"))
      ? {
          value: "artifacts/source-lock/magicblock-status-devnet-latest.json",
          source: "check-magicblock-status.ts",
        }
      : unresolved("run `pnpm check-magicblock-status` to capture one"),
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (checkOnly) {
    if (!existsSync(REPORT_PATH)) {
      console.error(`missing ${REPORT_PATH}; run \`pnpm source-lock\` first`);
      process.exitCode = 1;
      return;
    }
    const previous = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as Record<string, unknown>;
    const stripVolatile = (o: Record<string, unknown>): string => {
      const { captured_at, repository_commit, repository_dirty, ...rest } = o;
      void captured_at;
      void repository_commit;
      void repository_dirty;
      return JSON.stringify(rest, null, 2);
    };
    if (stripVolatile(previous) !== stripVolatile(report as unknown as Record<string, unknown>)) {
      console.error(
        "version-report.json is stale. Re-run `pnpm source-lock` and commit the result.",
      );
      process.exitCode = 1;
      return;
    }
    console.log("version-report.json is current (ignoring captured_at and repository state).");
    return;
  }

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(REPORT_PATH, serialized);
  console.log(`Wrote ${REPORT_PATH}`);

  const gaps: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if ("value" in record && "reason" in record && record.value === null) {
      gaps.push(`${path}: ${String(record.reason)}`);
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(report, "");

  if (gaps.length > 0) {
    console.log("\nUnresolved fields (recorded as null, not guessed):");
    for (const gap of gaps) console.log(`  - ${gap}`);
  }
}

await main();
