#!/usr/bin/env node
/**
 * Cline hooks adapter - one-shot CLI entry point.
 *
 * Cline invokes this process once per hook event:
 *   1. Writes a JSON payload to this process's stdin.
 *   2. Reads back the JSON response from stdout.
 *   3. The process exits with code 0 on success, non-zero on fatal error.
 *
 * Logging goes to stderr so that stdout stays clean for the JSON protocol.
 *
 * Usage (configured in .cline/hooks.json):
 *   "command": "gdc"
 */

import { handleClineHook } from "./handlers";
import { registerHook } from "./hooks";
import type { HookName } from "./hooks";
import { initClineHooks, deinitClineHooks } from "./init";
import {
  resolveConfigPath,
  resolvePluginEntry,
  readConfig,
  applyPlugin,
  removeConfiguredPlugin,
  upsertPlugin,
  removePlugin,
  OpencodeInitError,
} from "../opencode/init";
import type { ApplyResult } from "../opencode/init";
import * as readline from "node:readline";
import { syncWikiKb, checkWikiKb, resolveWikiSources, ensureKbVisible } from "../../core/kb-sync";
import * as tty from "node:tty";
import { VERSION } from "../../version";

function printHelp(): void {
  const help = `
gdc - Gordian Coder Cline Hooks Adapter v${VERSION}

Usage:
  gdc                        Cline hook 이벤트 처리 (stdin으로 JSON 수신)
  gdc --init [options]       Hook 스크립트 설치
  gdc --deinit [options]     Hook 스크립트 제거
  gdc --init-opencode [opts] opencode.json에 이 설치본을 플러그인으로 등록
  gdc --deinit-opencode [opts]   opencode.json에서 플러그인 등록 제거
  gdc kb-sync [options]      git wiki의 md 문서를 KB 디렉토리로 동기화
  gdc --help, -h             도움말 표시
  gdc --version, -v          버전 표시

Options:
  --global                   글로벌 hooks 디렉토리 사용 (~/Documents/Cline/Hooks/)
  --force                    기존 hook 스크립트 덮어쓰기

init-opencode / deinit-opencode options:
  --global                   전역 설정 사용 (~/.config/opencode/opencode.json,
                             OPENCODE_CONFIG 가 있으면 그 파일)
  --config <path>            설정 파일 경로를 직접 지정
  --yes, -y                  확인 프롬프트 없이 적용

kb-sync options:
  --name <name>              해당 wikiKb 항목만 대상으로
  --check                    원격과 비교만 (최신 여부 확인, 다운로드 없음)
  --dry-run                  clone 후 개수만 보고, 파일은 쓰지 않음
  --force                    최신이어도 다시 내려받기

Examples:
  gdc --init                 프로젝트 로컬 hooks 설치 (.clinerules/hooks/)
  gdc --init --global        글로벌 hooks 설치
  gdc --init --force         기존 hooks 덮어쓰기
  gdc --deinit               프로젝트 로컬 hooks 제거
  gdc --deinit --global      글로벌 hooks 제거
  gdc --init-opencode        ./opencode.json 에 플러그인 등록
  gdc --init-opencode --global   전역 opencode 설정에 등록
  gdc --deinit-opencode --global 전역 opencode 설정에서 제거
  gdc kb-sync                .fico/config/fico_ai.json의 wikiKb 전체 동기화
  gdc kb-sync --check        최신 여부만 확인
  gdc kb-sync --name fico_framework --force

Documentation:
  https://github.com/gordian-coder/gordian-coder
`.trimStart();
  process.stderr.write(help);
}

// ── Default handlers ─────────────────────────────────────────────
// Register a log-only handler for every hook type so that Cline always
// gets a valid response even before the user configures custom handlers.

const hookNames: HookName[] = [
  "TaskStart",
  "TaskResume",
  "TaskCancel",
  "TaskComplete",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreCompact",
];

for (const name of hookNames) {
  registerHook(name, async (event) => {
    // Retrieve the hook-specific payload using the camelCase key convention.
    const hookData = (event as Record<string, unknown>)[camelCase(event.hookName)];
    process.stderr.write(
      `[gordian-coder:cline] ${event.hookName} | task=${event.taskId} | data=${JSON.stringify(hookData ?? {})}\n`
    );

    // UserPromptSubmit: echo the user's prompt back as contextModification
    if (event.hookName === "UserPromptSubmit" && event.userPromptSubmit) {
      return {
        cancel: false,
        contextModification: event.userPromptSubmit.prompt,
        errorMessage: "",
      };
    }

    return { cancel: false, contextModification: "", errorMessage: "" };
  });
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Convert a PascalCase hook name to the camelCase property key used on
 * HookEvent (e.g. "TaskStart" → "taskStart", "PreToolUse" → "preToolUse").
 */
function camelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Read all bytes from stdin and return them as a UTF-8 string.
 * Returns an empty string when stdin is empty or closed immediately.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ── kb-sync ──────────────────────────────────────────────────────

/**
 * Mirror every configured git wiki into the KB. One source failing does not
 * stop the others — a partial KB beats no KB — but the exit code still
 * reports it so CI can fail.
 */
async function runKbSync(rest: string[]): Promise<void> {
  const cwd = process.cwd();
  const nameIdx = rest.indexOf("--name");
  const name = nameIdx >= 0 ? rest[nameIdx + 1] : undefined;
  const dryRun = rest.includes("--dry-run");

  if (nameIdx >= 0 && !name) {
    process.stderr.write("[gordian-coder:kb] --name requires a value\n");
    process.exit(1);
  }

  const sources = resolveWikiSources(cwd);
  if (sources.length === 0) {
    process.stderr.write(
      "[gordian-coder:kb] no `wikiKb` configured — add one to .fico/config/fico_ai.json\n"
    );
    return;
  }
  if (name && !sources.some((s) => s.name === name)) {
    process.stderr.write(
      `[gordian-coder:kb] unknown source "${name}" (have: ${sources.map((s) => s.name).join(", ")})\n`
    );
    process.exit(1);
  }

  // --check: compare only. Exit 1 on stale/never-synced so CI can gate on it.
  if (rest.includes("--check")) {
    const checks = await checkWikiKb(cwd, { name });
    let outdated = 0;
    for (const c of checks) {
      const short = (sha?: string) => sha?.slice(0, 8) ?? "-";
      if (c.status === "up-to-date") {
        process.stderr.write(`  ✔ ${c.name} 최신 (${short(c.local)}, ${c.syncedAt})\n`);
      } else if (c.status === "stale") {
        outdated++;
        process.stderr.write(
          `  ↻ ${c.name} 갱신 필요 — 로컬 ${short(c.local)} / 원격 ${short(c.remote)} (마지막 동기화 ${c.syncedAt})\n`
        );
      } else if (c.status === "never-synced") {
        outdated++;
        process.stderr.write(`  · ${c.name} 미동기화 — 원격 ${short(c.remote)}\n`);
      } else {
        outdated++;
        process.stderr.write(`  ✖ ${c.name} → ${c.error}\n`);
      }
    }
    if (outdated > 0) process.exit(1);
    return;
  }

  const results = await syncWikiKb(cwd, { name, dryRun, force: rest.includes("--force") });
  let failed = 0;
  for (const r of results) {
    const short = r.commit ? ` @${r.commit.slice(0, 8)}` : "";
    if (r.error) {
      failed++;
      process.stderr.write(`  ✖ ${r.name} → ${r.error}\n`);
    } else if (r.upToDate) {
      process.stderr.write(`  = ${r.name} 이미 최신${short} — 건너뜀\n`);
    } else {
      process.stderr.write(
        `  ✔ ${r.name} → ${r.dest} (${r.files} md${short}${dryRun ? ", dry-run" : ""})\n`
      );
    }
  }

  if (!dryRun && failed < results.length && ensureKbVisible(cwd)) {
    process.stderr.write(
      "  + .ignore에 `!.fico` 추가 — 이게 없으면 ripgrep 기반 검색(opencode glob 등)이 .fico를 건너뜁니다\n"
    );
  }

  if (failed > 0) process.exit(1);
}

// ── init-opencode ────────────────────────────────────────────────

/** Ask a y/N question. EOF (non-TTY) counts as "no". */
async function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function printPlugins(label: string, plugins: string[], entry?: string): void {
  process.stderr.write(`\n  ${label}\n`);
  if (plugins.length === 0) {
    process.stderr.write("    (없음)\n");
    return;
  }
  for (const p of plugins) {
    // Mark the line we are adding/keeping so the diff is obvious at a glance.
    const mark = entry && p === entry ? "→" : " ";
    process.stderr.write(`   ${mark} ${p}\n`);
  }
}

/**
 * Register this installation's OpenCode adapter in opencode.json:
 * show the current state, confirm, write, then show the result.
 */
/** Shared arg handling + "which file, and why" banner for both directions. */
function openConfigForEdit(args: string[], creates: boolean) {
  const configIdx = args.indexOf("--config");
  const configPath = configIdx >= 0 ? args[configIdx + 1] : undefined;
  if (configIdx >= 0 && !configPath) {
    process.stderr.write("[gordian-coder:opencode] --config requires a value\n");
    process.exit(1);
  }

  const resolved = resolveConfigPath({ global: args.includes("--global"), configPath });
  const state = readConfig(resolved.path);

  const missing = creates ? " (없음 → 새로 생성)" : " (없음)";
  process.stderr.write(
    `\n[gordian-coder:opencode] 설정 파일: ${state.path}${state.exists ? "" : missing}\n`
  );
  process.stderr.write(`[gordian-coder:opencode] 경로 결정 근거: ${resolved.origin}\n`);

  return {
    state,
    assumeYes: args.includes("--yes") || args.includes("-y") || args.includes("--force"),
  };
}

/** Confirm before touching the user's config. Returns false when declined. */
async function confirmEdit(assumeYes: boolean, question: string): Promise<boolean> {
  if (assumeYes) return true;
  if (!tty.isatty(0)) {
    process.stderr.write(
      "\n  대화형 터미널이 아닙니다. 확인 없이 적용하려면 --yes 를 사용하세요.\n\n"
    );
    process.exit(1);
  }
  if (await askYesNo(question)) return true;
  process.stderr.write("  취소되었습니다. 설정은 변경되지 않았습니다.\n\n");
  return false;
}

function reportWritten(result: ApplyResult, entry?: string): void {
  process.stderr.write(`\n  [OK] ${result.created ? "생성" : "수정"} 완료: ${result.path}\n`);
  if (result.backup) process.stderr.write(`  백업: ${result.backup}\n`);

  // Re-read from disk so what we print is what OpenCode will actually load.
  printPlugins("적용된 plugin 설정:", readConfig(result.path).plugins, entry);
  process.stderr.write("\n  OpenCode를 재시작하면 적용됩니다.\n\n");
}

async function runInitOpencode(args: string[]): Promise<void> {
  const entry = resolvePluginEntry();
  const { state, assumeYes } = openConfigForEdit(args, true);

  process.stderr.write(`[gordian-coder:opencode] 등록할 플러그인: ${entry}\n`);
  printPlugins("현재 plugin 설정:", state.plugins);

  const after = upsertPlugin(state.plugins, entry);
  if (sameList(after, state.plugins)) {
    process.stderr.write("\n  이미 이 설치본으로 등록되어 있습니다. 변경할 내용이 없습니다.\n\n");
    return;
  }

  printPlugins("변경 후 plugin 설정:", after, entry);
  if (!(await confirmEdit(assumeYes, "\n  이 내용으로 수정하시겠습니까? (y/N): "))) return;

  reportWritten(applyPlugin(state, entry), entry);
}

/**
 * Unregister gordian-coder from opencode.json. Removes every gordian entry,
 * not just this install's path — a config can carry a stale one from an
 * earlier install location, and leaving that behind defeats the point.
 */
async function runDeinitOpencode(args: string[]): Promise<void> {
  const { state, assumeYes } = openConfigForEdit(args, false);

  if (!state.exists) {
    process.stderr.write("\n  설정 파일이 없습니다. 제거할 내용이 없습니다.\n\n");
    return;
  }

  printPlugins("현재 plugin 설정:", state.plugins);

  const after = removePlugin(state.plugins);
  if (sameList(after, state.plugins)) {
    process.stderr.write("\n  등록된 gordian-coder 플러그인이 없습니다. 변경할 내용이 없습니다.\n\n");
    return;
  }

  const removed = state.plugins.filter((p) => !after.includes(p));
  printPlugins("제거될 항목:", removed);
  printPlugins("변경 후 plugin 설정:", after);

  if (!(await confirmEdit(assumeYes, "\n  이 항목을 제거하시겠습니까? (y/N): "))) return;

  reportWritten(removeConfiguredPlugin(state));
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ── Arg validation ───────────────────────────────────────────────

/**
 * Flags accepted per command. Anything else is a typo or an option this build
 * does not have — both must fail loudly.
 *
 * Without this, an unknown flag fell through to the stdin hook path: `gdc
 * --init-opencode` on a build without that option printed "Invalid JSON input"
 * instead of an error, and with a terminal attached it would just hang waiting
 * for stdin. Hooks always invoke `gdc` with no arguments, so any argument at
 * all means CLI intent and can be validated strictly.
 */
const COMMAND_FLAGS: Record<string, string[]> = {
  "--init": ["--global", "--force"],
  "--deinit": ["--global", "--force"],
  "--init-opencode": ["--global", "--config", "--yes", "-y", "--force"],
  "--deinit-opencode": ["--global", "--config", "--yes", "-y", "--force"],
};
const KB_SYNC_FLAGS = ["--name", "--check", "--dry-run", "--force"];
/** Flags whose next argument is a value, not another flag. */
const VALUE_FLAGS = ["--config", "--name"];
const GLOBAL_FLAGS = ["--help", "-h", "--version", "-v"];

function rejectUnknownArgs(args: string[]): void {
  if (args.length === 0) return; // hook mode / TTY help
  if (args.includes("--help") || args.includes("-h")) return;

  const isKbSync = args[0] === "kb-sync";
  const rest = isKbSync ? args.slice(1) : args;

  const allowed = new Set(GLOBAL_FLAGS);
  if (isKbSync) {
    for (const f of KB_SYNC_FLAGS) allowed.add(f);
  } else {
    for (const [command, flags] of Object.entries(COMMAND_FLAGS)) {
      if (!args.includes(command)) continue;
      allowed.add(command);
      for (const f of flags) allowed.add(f);
    }
  }

  const fail = (reason: string): never => {
    process.stderr.write(`[gordian-coder:cline] ${reason}\n\n`);
    printHelp();
    process.exit(1);
  };

  // A bare `gdc --version` is fine; anything else needs a command to belong to.
  if (!isKbSync && allowed.size === GLOBAL_FLAGS.length) {
    const hasGlobalOnly = rest.every((a) => GLOBAL_FLAGS.includes(a));
    if (!hasGlobalOnly) fail(`Unknown command: ${rest.filter((a) => !GLOBAL_FLAGS.includes(a)).join(" ")}`);
    return;
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("-")) {
      fail(`Unexpected argument: ${arg}`);
    }
    if (!allowed.has(arg)) {
      fail(`Unknown option: ${arg}`);
    }
    if (VALUE_FLAGS.includes(arg)) i++; // skip its value
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Arg parsing ────────────────────────────────────────────────
  const args = process.argv.slice(2);
  // Reject typos/unsupported options up front — never let them reach the
  // stdin hook path, where they surface as a JSON error or an idle hang.
  rejectUnknownArgs(args);
  const hasInit = args.includes("--init");
  const hasDeinit = args.includes("--deinit");
  const isGlobal = args.includes("--global");
  const isForce = args.includes("--force");

  const hasHelp = args.includes("--help") || args.includes("-h");
  const hasVersion = args.includes("--version") || args.includes("-v");

  if (hasHelp) {
    printHelp();
    process.exit(0);
  }

  if (hasVersion) {
    process.stderr.write(`gdc v${VERSION}\n`);
    process.exit(0);
  }

  if (args[0] === "kb-sync") {
    await runKbSync(args.slice(1));
    return;
  }

  const hasInitOpencode = args.includes("--init-opencode");
  const hasDeinitOpencode = args.includes("--deinit-opencode");

  if (hasInitOpencode && hasDeinitOpencode) {
    process.stderr.write(
      "[gordian-coder:opencode] Error: cannot use --init-opencode and --deinit-opencode together.\n"
    );
    process.exit(1);
  }

  if (hasInitOpencode || hasDeinitOpencode) {
    try {
      await (hasInitOpencode ? runInitOpencode(args) : runDeinitOpencode(args));
    } catch (err) {
      if (err instanceof OpencodeInitError) {
        process.stderr.write(`\n[gordian-coder:opencode] ${err.message}\n\n`);
        process.exit(1);
      }
      throw err;
    }
    process.exit(0);
  }

  if (hasInit && hasDeinit) {
    process.stderr.write(
      "[gordian-coder:cline] Error: cannot use --init and --deinit together.\n"
    );
    process.exit(1);
  }

  if (hasInit) {
    const result = await initClineHooks({ global: isGlobal, force: isForce });
    process.stderr.write(
      `[gordian-coder:cline] Hooks initialized in ${result.hooksDir}\n`
    );
    for (const f of result.created) process.stderr.write(`  + ${f}\n`);
    for (const f of result.skipped)
      process.stderr.write(`  ~ ${f} (skipped, use --force to overwrite)\n`);
    process.exit(0);
  }

  if (hasDeinit) {
    const result = await deinitClineHooks({ global: isGlobal, force: false });
    process.stderr.write(
      `[gordian-coder:cline] Hooks removed from ${result.hooksDir}\n`
    );
    for (const f of result.removed) process.stderr.write(`  - ${f}\n`);
    process.exit(0);
  }

  // ── Interactive mode: no args + TTY stdin → show help ──────────
  if (args.length === 0 && tty.isatty(0)) {
    printHelp();
    process.exit(0);
  }

  // ── Existing stdin / stdout flow (unchanged) ───────────────────
  const input = await readStdin();
  const output = await handleClineHook(input);
  process.stdout.write(output);
}

main().catch((err) => {
  process.stderr.write(`[gordian-coder:cline] Fatal: ${err}\n`);
  process.stdout.write(
    JSON.stringify({ cancel: false, contextModification: "", errorMessage: String(err) })
  );
  process.exit(1);
});
