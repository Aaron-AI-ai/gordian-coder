import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewEvidence,
  discoverRelatedFiles,
  gitHistory,
  renderRelatedCode,
  unresolvedImports,
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
    // Import evidence names the functions the file actually calls.
    expect(byPath.get("src/repository.ts")).toContain("uses: saveUser()");
  });

  it("lists member calls on an imported Java class (bean-idiom instance included)", () => {
    const cwd = repo();
    writeFileSync(
      join(cwd, "src/OrderService.java"),
      [
        "import com.shop.OrderRepository;",
        "class OrderService {",
        "  OrderRepository orderRepository;",
        "  void place() { orderRepository.save(); OrderRepository.of(); }",
        "}",
      ].join("\n")
    );
    writeFileSync(join(cwd, "src/OrderRepository.java"), "class OrderRepository {}\n");
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
    git(["add", "-A"]);
    git(["commit", "-qm", "add order service"]);

    const related = discoverRelatedFiles(cwd, "HEAD", "src/OrderService.java");
    const reason = related
      .find((r) => r.path === "src/OrderRepository.java")
      ?.reasons.find((s) => s.startsWith("direct import"));
    expect(reason).toContain("orderRepository.save()");
    expect(reason).toContain("OrderRepository.of()");
  });

  it("skips wildcard imports instead of stem-matching the package name", () => {
    const cwd = repo();
    // `import com.foo.dto.*;` must not match a file whose stem is "dto".
    mkdirSync(join(cwd, "src/dto"), { recursive: true });
    writeFileSync(join(cwd, "src/dto.java"), "class dto {}\n");
    writeFileSync(join(cwd, "src/Order.java"), "import com.foo.dto.*;\nclass Order {}\n");
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
    git(["add", "-A"]);
    git(["commit", "-qm", "add java files"]);

    const related = discoverRelatedFiles(cwd, "HEAD", "src/Order.java");
    const imported = related.filter((r) => r.reasons.some((s) => s.startsWith("direct import")));
    expect(imported.map((r) => r.path)).not.toContain("src/dto.java");
  });

  it("resolves a tsconfig path alias to a repository-local directory index", () => {
    const cwd = repo();
    mkdirSync(join(cwd, "src/lib"), { recursive: true });
    writeFileSync(join(cwd, "src/lib/index.ts"), "export const localValue = () => 1;\n");
    writeFileSync(
      join(cwd, "src/alias-consumer.ts"),
      'import { localValue } from "@/lib";\nexport const value = localValue();\n'
    );
    writeFileSync(
      join(cwd, "tsconfig.json"),
      [
        "{",
        "  // JSONC is valid in a real tsconfig",
        '  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*",], }, },',
        "}",
      ].join("\n")
    );
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
    git(["add", "-A"]);
    git(["commit", "-qm", "add aliased module"]);

    const related = discoverRelatedFiles(cwd, "HEAD", "src/alias-consumer.ts");
    expect(related.find((item) => item.path === "src/lib/index.ts")?.reasons.join(" ")).toContain(
      "direct import: @/lib"
    );
    expect(unresolvedImports(cwd, "HEAD", "src/alias-consumer.ts")).not.toContain("@/lib");
  });

  it("resolves an internal workspace package to its source index", () => {
    const cwd = repo();
    mkdirSync(join(cwd, "packages/shared/src"), { recursive: true });
    writeFileSync(join(cwd, "packages/shared/package.json"), '{"name":"@shop/shared"}\n');
    writeFileSync(
      join(cwd, "packages/shared/src/index.ts"),
      "export const sharedValue = () => 1;\n"
    );
    writeFileSync(
      join(cwd, "src/package-consumer.ts"),
      'import { sharedValue } from "@shop/shared";\nexport const value = sharedValue();\n'
    );
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
    git(["add", "-A"]);
    git(["commit", "-qm", "add workspace package"]);

    const related = discoverRelatedFiles(cwd, "HEAD", "src/package-consumer.ts");
    expect(related.find((item) => item.path === "packages/shared/src/index.ts")).toBeDefined();
    expect(unresolvedImports(cwd, "HEAD", "src/package-consumer.ts")).toEqual([]);
  });

  it("resolves Python packages and Java static imports beneath source roots", () => {
    const cwd = repo();
    mkdirSync(join(cwd, "app/lib"), { recursive: true });
    mkdirSync(join(cwd, "src/main/java/com/shop/util"), { recursive: true });
    writeFileSync(join(cwd, "app/__init__.py"), "");
    writeFileSync(join(cwd, "app/lib/__init__.py"), "def load(): return 1\n");
    writeFileSync(join(cwd, "app/service.py"), "from app.lib import load\nvalue = load()\n");
    writeFileSync(
      join(cwd, "src/main/java/com/shop/util/OrderFactory.java"),
      "package com.shop.util; public class OrderFactory { public static void create() {} }\n"
    );
    writeFileSync(
      join(cwd, "src/main/java/com/shop/OrderService.java"),
      "import static com.shop.util.OrderFactory.create;\nclass OrderService { void run() { create(); } }\n"
    );
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd });
    git(["add", "-A"]);
    git(["commit", "-qm", "add language package imports"]);

    expect(discoverRelatedFiles(cwd, "HEAD", "app/service.py").map((item) => item.path)).toContain(
      "app/lib/__init__.py"
    );
    expect(
      discoverRelatedFiles(cwd, "HEAD", "src/main/java/com/shop/OrderService.java").map(
        (item) => item.path
      )
    ).toContain("src/main/java/com/shop/util/OrderFactory.java");
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

  it("keeps each commit's co-changed files separate (one batched git show, not smeared)", () => {
    const out = gitHistory(repo(), "src/user-service.ts", 2, false);
    const [newest, older] = out
      .split("\n")
      .filter((l) => l.startsWith("  changed together:"));
    // Newest commit touched only repository.ts alongside the file under review;
    // controller.ts / the test came with the first commit.
    expect(newest).toContain("src/repository.ts");
    expect(newest).not.toContain("src/controller.ts");
    expect(older).toContain("src/controller.ts");
    expect(older).toContain("tests/user-service.test.ts");
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
