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
  gdc kb-sync [options]      git wiki의 md 문서를 KB 디렉토리로 동기화
  gdc --help, -h             도움말 표시
  gdc --version, -v          버전 표시

Options:
  --global                   글로벌 hooks 디렉토리 사용 (~/Documents/Cline/Hooks/)
  --force                    기존 hook 스크립트 덮어쓰기

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

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Arg parsing ────────────────────────────────────────────────
  const args = process.argv.slice(2);
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
