/**
 * OpenCode config init utilities.
 *
 * Registers this installation's OpenCode plugin entry in `opencode.json`.
 * OpenCode resolves plugin entries by absolute path to the built adapter
 * (see the user's real config), not by package name — so the entry we write
 * is derived from where this CLI itself is running from.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";

/** Plugin entries ending with this belong to gordian-coder. */
const PLUGIN_SUFFIX = "adapters/opencode/index.js";

export interface OpencodeInitOptions {
  global: boolean;
  cwd?: string; // override for testing
  configPath?: string; // explicit --config override
  env?: NodeJS.ProcessEnv; // override for testing
}

/** Where a resolved config path came from — shown to the user before writing. */
export type ConfigOrigin =
  | "--config"
  | "OPENCODE_CONFIG"
  | "전역 설정 (~/.config/opencode)"
  | "프로젝트 로컬";

export interface ResolvedConfig {
  path: string;
  origin: ConfigOrigin;
}

export class OpencodeInitError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OpencodeInitError";
  }
}

/**
 * Pick the config file inside a directory. OpenCode accepts both extensions,
 * so an existing .jsonc wins over creating a new .json next to it.
 */
function configInDir(dir: string): string {
  const jsonc = path.join(dir, "opencode.jsonc");
  if (!fs.existsSync(path.join(dir, "opencode.json")) && fs.existsSync(jsonc)) {
    return jsonc;
  }
  return path.join(dir, "opencode.json");
}

/**
 * Resolve which opencode config file to edit.
 *
 * The documented global config is `~/.config/opencode/opencode.json` on every
 * platform, Windows included — not %APPDATA%. `OPENCODE_CONFIG` names a custom
 * config FILE and is the only env override for the file's location.
 *
 * `OPENCODE_CONFIG_DIR` is deliberately NOT consulted: it points at a directory
 * of agents/commands/modes/plugins, not at opencode.json. Treating it as the
 * config file location wrote to a file OpenCode never reads.
 */
export function resolveConfigPath(options: OpencodeInitOptions): ResolvedConfig {
  const env = options.env ?? process.env;

  if (options.configPath) {
    return { path: path.resolve(options.configPath), origin: "--config" };
  }

  if (!options.global) {
    return { path: configInDir(options.cwd ?? process.cwd()), origin: "프로젝트 로컬" };
  }

  if (env.OPENCODE_CONFIG) {
    return { path: path.resolve(env.OPENCODE_CONFIG), origin: "OPENCODE_CONFIG" };
  }
  return {
    path: configInDir(path.join(os.homedir(), ".config", "opencode")),
    origin: "전역 설정 (~/.config/opencode)",
  };
}

/**
 * Absolute path of the OpenCode adapter belonging to THIS installation.
 *
 * Derived from the running bundle's own location (dist/adapters/cline/cli.js
 * → dist/adapters/opencode/index.js) so that an install into any INSTALL_DIR
 * registers itself, not whatever happens to be on PATH.
 */
export function resolvePluginEntry(fromDir: string = import.meta.dir): string {
  const entry = path.resolve(fromDir, "..", "opencode", "index.js");
  if (!fs.existsSync(entry)) {
    throw new OpencodeInitError(
      `OpenCode 어댑터를 찾을 수 없습니다: ${entry}\n` +
        `  빌드되지 않은 소스에서 실행 중이라면 먼저 \`bun run build\` 후 다시 시도하세요.`,
    );
  }
  // OpenCode는 `file://`로 시작하지 않는 plugin 항목을 npm 패키지로 간주해 레지스트리에
  // 설치를 시도한다. Windows 경로(C:\...\index.js)는 그 검사를 통과하지 못해, 폐쇄망에서
  // npm 기본 타임아웃(5분)을 그대로 기다리게 된다. 그래서 항상 file:// URL로 적는다.
  return pathToFileURL(entry).href;
}

/** True when a plugin entry is a gordian-coder one (any install path). */
export function isGordianEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/");
  return normalized.endsWith(PLUGIN_SUFFIX) || normalized === "gordian-coder";
}

export interface ConfigState {
  path: string;
  exists: boolean;
  config: Record<string, unknown>;
  plugins: string[];
}

/**
 * Read opencode.json. A missing file is fine (we create it); a malformed one
 * is not — rewriting it would destroy content we cannot round-trip.
 */
export function readConfig(configPath: string): ConfigState {
  if (!fs.existsSync(configPath)) {
    return { path: configPath, exists: false, config: {}, plugins: [] };
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  let config: unknown;
  try {
    // Windows PowerShell의 `Set-Content -Encoding UTF8`을 비롯해 여러 편집기가
    // UTF-8 BOM을 붙인다. JSON.parse는 BOM에서 던지지만 OpenCode 자신은 이런
    // 파일을 문제없이 읽으므로, 여기서만 거부하면 우리 쪽 버그가 된다.
    config = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    throw new OpencodeInitError(
      `설정 파일을 파싱할 수 없습니다: ${configPath}\n` +
        `  주석이나 문법 오류가 있으면 자동 수정하지 않습니다 (내용이 손실될 수 있음).\n` +
        `  직접 고친 뒤 다시 실행하거나, plugin 항목을 수동으로 추가하세요.`,
      err,
    );
  }

  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new OpencodeInitError(`설정 파일의 최상위가 객체가 아닙니다: ${configPath}`);
  }

  const record = config as Record<string, unknown>;
  const rawPlugins = record.plugin;
  const plugins = Array.isArray(rawPlugins)
    ? rawPlugins.filter((p): p is string => typeof p === "string")
    : [];

  return { path: configPath, exists: true, config: record, plugins };
}

/**
 * Replace any existing gordian-coder entry with `entry`, keeping every other
 * plugin untouched. Replacing (not appending) is what makes a reinstall into a
 * new INSTALL_DIR safe — otherwise the stale path lingers and OpenCode loads
 * a plugin that no longer exists.
 */
export function upsertPlugin(plugins: string[], entry: string): string[] {
  return [...removePlugin(plugins), entry];
}

/** Drop every gordian-coder entry, keeping every other plugin untouched. */
export function removePlugin(plugins: string[]): string[] {
  return plugins.filter((p) => !isGordianEntry(p));
}

export interface ApplyResult {
  path: string;
  created: boolean;
  backup?: string;
  before: string[];
  after: string[];
}

/** Write the given plugin list, backing up any file we overwrite. */
export function writePlugins(state: ConfigState, after: string[]): ApplyResult {
  let backup: string | undefined;
  if (state.exists) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    backup = `${state.path}.bak-${stamp}`;
    fs.copyFileSync(state.path, backup);
  } else {
    fs.mkdirSync(path.dirname(state.path), { recursive: true });
  }

  const next = { ...state.config, plugin: after };
  fs.writeFileSync(state.path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");

  return {
    path: state.path,
    created: !state.exists,
    backup,
    before: state.plugins,
    after,
  };
}

/** Register `entry`, replacing any stale gordian-coder entry. */
export function applyPlugin(state: ConfigState, entry: string): ApplyResult {
  return writePlugins(state, upsertPlugin(state.plugins, entry));
}

/** Unregister every gordian-coder entry. */
export function removeConfiguredPlugin(state: ConfigState): ApplyResult {
  return writePlugins(state, removePlugin(state.plugins));
}
