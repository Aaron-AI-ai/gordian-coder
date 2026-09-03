import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildReviewEvidence, reviewEvidence } from "../dossier";

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

  it("labels unmapped third-party imports as unresolved and permits one targeted lookup", () => {
    const cwd = repo();
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
    writeFileSync(
      join(cwd, "src/Svc.java"),
      [
        "import java.util.List;", // JDK — filtered out as noise
        "import kr.co.koscom.pb.framework.site.ext.exception.PBOnlineException;", // external
        "public class Svc {}",
      ].join("\n")
    );
    git(["add", "-A"]);
    git(["commit", "-qm", "add java service"]);

    const out = buildReviewEvidence(cwd, "HEAD", "src/Svc.java");
    expect(out).toContain("Unresolved imports (not confirmed external)");
    expect(out).toContain("PBOnlineException");
    expect(out).toContain("one targeted code_search(<symbol>) or file_find lookup");
    expect(out).not.toContain("NEVER search");
    expect(out).not.toContain("they are external");
    expect(out).not.toContain("java.util.List");
    // A file whose imports all resolve gets no unresolved section at all.
    expect(buildReviewEvidence(cwd, "HEAD", "src/controller.ts")).not.toContain("Unresolved imports");
  });
});

describe("injected import sources and framework KB", () => {
  /** Java project with a repo-resolved import, a KB-documented framework
   * import, and third-party noise. */
  function javaRepo(): string {
    const cwd = mkdtempSync(join(tmpdir(), "k-evidence-kb-"));
    tmps.push(cwd);
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
    git(["init", "-q"]);
    git(["config", "user.email", "review@test"]);
    git(["config", "user.name", "Reviewer"]);

    const write = (path: string, body: string) => {
      mkdirSync(join(cwd, dirname(path)), { recursive: true });
      writeFileSync(join(cwd, path), body);
    };
    write(".f-review.json", JSON.stringify({
      frameworkKb: { "kr.co.openlabs.fico.framework.*": ".fico/kb/core/" },
    }));
    write(".fico/kb/core/utils/DateUtils.md", "# DateUtils\nAlways pass a ZoneId.\n");
    write("src/main/java/app/model/Account.java", "package app.model;\npublic class Account { public String getNo() { return no; } }\n");
    write(
      "src/main/java/app/Service.java",
      [
        "package app;",
        "import app.model.Account;",
        "import kr.co.openlabs.fico.framework.utils.DateUtils;",
        "import org.springframework.stereotype.Service;",
        "import java.util.List;",
        "public class Service { }",
      ].join("\n")
    );
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    return cwd;
  }

  it("injects the source of imports that resolve to repository files", () => {
    const ev = reviewEvidence(javaRepo(), "HEAD", "src/main/java/app/Service.java");
    expect(ev.sources).toContain("src/main/java/app/model/Account.java");
    expect(ev.text).toContain("## Imported project code");
    expect(ev.text).toContain("public String getNo()"); // the actual source, not a path
  });

  it("injects the KB page for a framework import and names it in the audit", () => {
    const ev = reviewEvidence(javaRepo(), "HEAD", "src/main/java/app/Service.java");
    expect(ev.text).toContain("## Framework knowledge base");
    expect(ev.text).toContain("Always pass a ZoneId.");
    expect(ev.docs).toEqual([
      ".fico/kb/core/utils/DateUtils.md (kr.co.openlabs.fico.framework.utils.DateUtils)",
    ]);
  });

  it("drops inlined imports from the candidate list instead of asking not to re-read them", () => {
    // A listed path is an invitation. A small model that ignores one instruction
    // ("do not re-read these") spends its tool budget re-fetching what it already
    // has; a path it never sees costs nothing to resist.
    const ev = reviewEvidence(javaRepo(), "HEAD", "src/main/java/app/Service.java");
    const list = ev.text.split("## Imported project code")[0];
    expect(ev.sources).toContain("src/main/java/app/model/Account.java");
    expect(list).not.toContain("src/main/java/app/model/Account.java");
    expect(ev.text).toContain("NOT yet read");
  });

  it("keeps an import the section budget dropped listed as a candidate", () => {
    // Injection is best-effort under a byte budget; a file that did not make it
    // must stay fetchable, or it becomes invisible in both halves of the dossier.
    const cwd = javaRepo();
    const write = (path: string, body: string) => {
      mkdirSync(join(cwd, dirname(path)), { recursive: true });
      writeFileSync(join(cwd, path), body);
    };
    // Each file is truncated to the per-file cap first, so the section budget is
    // reached by COUNT, not by one huge file.
    const bulky = ["A", "B", "C", "D", "E", "F"];
    for (const name of bulky) {
      write(
        `src/main/java/app/model/${name}.java`,
        `package app.model;\npublic class ${name} { /* ${"x".repeat(5_000)} */ }\n`
      );
    }
    write(
      "src/main/java/app/Service.java",
      [
        "package app;",
        ...bulky.map((name) => `import app.model.${name};`),
        "public class Service { }",
      ].join("\n")
    );
    Bun.spawnSync(["git", "add", "-A"], { cwd });
    Bun.spawnSync(["git", "commit", "-qm", "bulky"], { cwd });

    const ev = reviewEvidence(cwd, "HEAD", "src/main/java/app/Service.java");
    const dropped = bulky
      .map((name) => `src/main/java/app/model/${name}.java`)
      .filter((path) => !ev.sources.includes(path));
    expect(dropped.length).toBeGreaterThan(0); // the budget cut at least one
    const list = ev.text.split("## Imported project code")[0];
    for (const path of dropped) expect(list).toContain(path);
  });

  it("never sends the reviewer after third-party or JDK imports", () => {
    // Listing these as "unresolved" is what made reviewers grep for Spring
    // annotations — a tool call and a turn spent to learn nothing.
    const ev = reviewEvidence(javaRepo(), "HEAD", "src/main/java/app/Service.java");
    expect(ev.text).not.toContain("org.springframework.stereotype.Service");
    expect(ev.text).not.toContain("java.util.List");
    expect(ev.text).not.toContain("## Unresolved imports");
  });

  it("keeps a genuinely unaccounted-for import in the unresolved list", () => {
    const cwd = javaRepo();
    const file = join(cwd, "src/main/java/app/Service.java");
    writeFileSync(
      file,
      `import com.acme.legacy.Widget;\n${readFileSync(file, "utf8")}`
    );
    Bun.spawnSync(["git", "add", "-A"], { cwd });
    Bun.spawnSync(["git", "commit", "-qm", "legacy"], { cwd });
    const ev = reviewEvidence(cwd, "HEAD", "src/main/java/app/Service.java");
    expect(ev.text).toContain("## Unresolved imports");
    expect(ev.text).toContain("com.acme.legacy.Widget");
  });

  it("does not rank this project's own review artifacts as related code", () => {
    // A run's review json embeds the reviewed class name, so the symbol-reference
    // signal used to surface a previous review above the real callers.
    const cwd = repo();
    mkdirSync(join(cwd, "fcq/f-review/runs/r1/reviews"), { recursive: true });
    writeFileSync(
      join(cwd, "fcq/f-review/runs/r1/reviews/src__user-service.ts.json"),
      JSON.stringify({ file: "src/user-service.ts", findings: [{ rule: "createUser" }] })
    );
    Bun.spawnSync(["git", "add", "-A"], { cwd });
    Bun.spawnSync(["git", "commit", "-qm", "run artifact"], { cwd });
    const ev = reviewEvidence(cwd, "HEAD", "src/user-service.ts");
    expect(ev.text).not.toContain("fcq/f-review/runs");
    expect(ev.text).toContain("src/controller.ts"); // real caller still ranked
  });
});
