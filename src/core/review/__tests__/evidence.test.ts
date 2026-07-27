import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewEvidence,
  discoverRelatedFiles,
  gitHistory,
  renderRelatedCode,
} from "../evidence";

const tmps: string[] = [];

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "k-evidence-"));
  tmps.push(cwd);
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "tests"), { recursive: true });

  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
  git(["init", "-q"]);
  git(["config", "user.email", "review@test"]);
  git(["config", "user.name", "Reviewer"]);

  writeFileSync(join(cwd, "src/repository.ts"), "export const saveUser = () => true;\n");
  writeFileSync(
    join(cwd, "src/user-service.ts"),
    'import { saveUser } from "./repository";\nexport function createUser() { return saveUser(); }\n'
  );
  writeFileSync(
    join(cwd, "src/controller.ts"),
    'import { createUser } from "./user-service";\nexport const postUser = () => createUser();\n'
  );
  writeFileSync(
    join(cwd, "tests/user-service.test.ts"),
    'import { createUser } from "../src/user-service";\ntest("create", () => createUser());\n'
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "add user flow"]);

  writeFileSync(join(cwd, "src/repository.ts"), "export const saveUser = () => false;\n");
  writeFileSync(
    join(cwd, "src/user-service.ts"),
    'import { saveUser } from "./repository";\nexport function createUser() { return !saveUser(); }\n'
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "change persistence behavior"]);
  return cwd;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("discoverRelatedFiles", () => {
  it("finds direct dependencies, reverse symbol users, tests, and co-changed files", () => {
    const related = discoverRelatedFiles(repo(), "HEAD", "src/user-service.ts");
    const byPath = new Map(related.map((item) => [item.path, item.reasons.join(" ")]));

    expect(byPath.get("src/repository.ts")).toContain("import");
    expect(byPath.get("src/controller.ts")).toContain("createUser");
    expect(byPath.get("tests/user-service.test.ts")).toContain("test");
    expect(byPath.get("src/repository.ts")).toContain("changed together");
  });

  it("renders bounded previews so a smaller model sees useful code immediately", () => {
    const cwd = repo();
    const out = renderRelatedCode(cwd, "HEAD", "src/user-service.ts", 4, true);
    expect(out).toContain("src/repository.ts");
    expect(out).toContain("saveUser");
    expect(out).toContain("Related code preview");
  });
});

describe("gitHistory", () => {
  it("shows recent commit metadata and files changed in the same commits", () => {
    const out = gitHistory(repo(), "src/user-service.ts", 2, false);
    expect(out).toContain("change persistence behavior");
    expect(out).toContain("add user flow");
    expect(out).toContain("src/repository.ts");
  });

  it("can include historical patches for deeper regression analysis", () => {
    const out = gitHistory(repo(), "src/user-service.ts", 1, true);
    expect(out).toContain("Historical patch");
    expect(out).toContain("return !saveUser()");
  });
});

describe("buildReviewEvidence", () => {
  it("combines related-code and history evidence in an automatically injected dossier", () => {
    const out = buildReviewEvidence(repo(), "HEAD", "src/user-service.ts");
    expect(out).toContain("Related code");
    expect(out).toContain("Git history");
    expect(out).toContain("src/controller.ts");
    expect(out.length).toBeLessThanOrEqual(8_000);
  });

  it("surfaces related files as a path list + grep recipe, not inlined previews", () => {
    const out = buildReviewEvidence(repo(), "HEAD", "src/user-service.ts");
    expect(out).toContain("src/repository.ts"); // ranked path candidate present
    expect(out).toContain("code_search(<symbol>)"); // recipe telling the model to grep
    expect(out).not.toContain("Related code preview"); // no first-lines preview auto-injected
  });
});
