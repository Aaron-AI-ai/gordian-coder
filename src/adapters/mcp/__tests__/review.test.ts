import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewTools } from "../review";
import { clearState } from "../../../core/review/pipeline/state";

const tmps: string[] = [];
afterEach(() => {
  clearState("mcp"); // the adapter's single fixed session id
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "f-mcp-review-"));
  tmps.push(d);
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: d });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(d, "a.ts"), "export const a = 1;\n");
  git(["add", "a.ts"]);
  git(["commit", "-qm", "init"]);
  return d;
}

describe("MCP review prompt block", () => {
  it("appends the per-file review prompt to context and submit results while a review is active", async () => {
    const d = gitRepo();
    const tools = createReviewTools(d);
    const byName = (n: string) => tools.find((t) => t.name === n)!;

    const started = await byName("f_review_context").execute({ files: ["a.ts"], language: "en" });
    expect(started.success).toBe(true);
    const text = started.data as string;
    expect(text).toContain("REVIEW PROMPT");
    expect(text).toContain("CURRENT_SUBMIT_TOKEN");
    expect(text).toContain("a.ts");

    // Exploration results carry no prompt block — only the loop-driving tools do.
    const explored = await byName("file_read").execute({ file_path: "a.ts" });
    expect(explored.data as string).not.toContain("REVIEW PROMPT");

    // A rejected submit still re-attaches the prompt so the client can recover.
    const rejected = await byName("f_review_submit").execute({ submitToken: "wrong", assessed: [], findings: [] });
    expect(rejected.success).toBe(true);
    expect(rejected.data as string).toContain("REVIEW PROMPT");
  });

  it("adds no prompt block once no review is active", async () => {
    const tools = createReviewTools(mkdtempSync(join(tmpdir(), "f-mcp-idle-")));
    const submit = tools.find((t) => t.name === "f_review_submit")!;
    const result = await submit.execute({ submitToken: "x", assessed: [], findings: [] });
    expect(result.data as string).toContain("No active review");
    expect(result.data as string).not.toContain("REVIEW PROMPT");
  });
});

describe("MCP review tools", () => {
  it("exposes deterministic related-code and git-history exploration", () => {
    const names = createReviewTools().map((tool) => tool.name);
    expect(names).toContain("related_code");
    expect(names).toContain("git_history");
    expect(names.at(-1)).toBe("f_review_submit");
  });

  it("keeps evidence tools inside an active review session", async () => {
    const related = createReviewTools().find((tool) => tool.name === "related_code")!;
    const result = await related.execute({});
    expect(result.success).toBe(true);
    expect(result.data).toContain("No active review");
  });
});
