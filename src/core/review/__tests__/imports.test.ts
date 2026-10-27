import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importBindings,
  importSpecifiers,
  isExternalImport,
  normalizeRepoPath,
  resolveImport,
  unresolvedImports,
} from "../imports";

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "f-imports-"));
  tmps.push(d);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(d, path, ".."), { recursive: true });
    writeFileSync(join(d, path), content);
  }
  return d;
}

describe("importSpecifiers", () => {
  it("collects every JS/TS import form once: from, require, dynamic import, side-effect", () => {
    const src = [
      `import a from "./a";`,
      `import { b } from './a';`, // same specifier → one entry
      `const c = require("c-lib");`,
      `const d = await import("./dyn");`,
      `import "./side-effect.css";`,
    ].join("\n");
    expect(importSpecifiers(src, "src/x.ts").sort()).toEqual(["./a", "./dyn", "./side-effect.css", "c-lib"]);
  });

  it("reads Java imports, including static ones, and drops wildcards", () => {
    const src = [
      `package com.app;`,
      `import com.app.svc.OrderService;`,
      `import static org.junit.Assert.assertEquals;`,
      `import com.app.util.*;`,
    ].join("\n");
    expect(importSpecifiers(src, "A.java").sort()).toEqual(["com.app.svc.OrderService", "org.junit.Assert.assertEquals"]);
  });

  it("reads Python imports and ignores bare relative dots", () => {
    const src = [`import os`, `from .models import User`, `from . import helpers`, `from ..pkg.mod import x`].join("\n");
    expect(importSpecifiers(src, "app/views.py").sort()).toEqual([".models", "..pkg.mod", "os"].sort());
  });

  it("leaves non-source files alone except for quoted from/require forms", () => {
    expect(importSpecifiers(`import "./a";`, "notes.md")).toEqual([]);
  });
});

describe("importBindings", () => {
  it("maps each specifier to the local names it binds, honouring aliases", () => {
    const m = importBindings(`import X, { a, b as c } from "./x";\nimport com.foo.Bar;`);
    expect(m.get("./x")).toEqual(["X", "a", "c"]);
    expect(m.get("com.foo.Bar")).toEqual(["Bar"]);
  });
});

describe("resolveImport", () => {
  const all = new Set(["src/a.ts", "src/util.ts", "src/lib/index.tsx", "src/types.d.ts", "src/style.css"]);

  it("resolves an emitted .js specifier to the .ts/.tsx/.d.ts source that exists", () => {
    expect(resolveImport("/x", null, "./util.js", "src/a.ts", all)).toEqual(["src/util.ts"]);
    expect(resolveImport("/x", null, "./lib/index.js", "src/a.ts", all)).toEqual(["src/lib/index.tsx"]);
    expect(resolveImport("/x", null, "./types.js", "src/a.ts", all)).toEqual(["src/types.d.ts"]);
  });

  it("resolves extensionless specifiers to a file or an index file", () => {
    expect(resolveImport("/x", null, "./util", "src/a.ts", all)).toEqual(["src/util.ts"]);
    expect(resolveImport("/x", null, "./lib", "src/a.ts", all)).toEqual(["src/lib/index.tsx"]);
  });

  it("keeps an exact specifier that names an existing file as-is", () => {
    expect(resolveImport("/x", null, "./style.css", "src/a.ts", all)).toEqual(["src/style.css"]);
  });

  it("resolves tsconfig path aliases, reading tsconfig written with comments and trailing commas", () => {
    const d = repo({
      "tsconfig.json": [
        "{",
        "  // line comment before the block",
        "  /* block",
        "     comment */",
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": { "@app/*": ["src/*"], },', // trailing comma
        "  },",
        "}",
      ].join("\n"),
      "src/a.ts": `import { u } from "@app/util";\nimport { q } from "@app/missing";\nimport "jakarta.x";\n`,
      "src/util.ts": "export const u = 1;\n",
    });
    const files = new Set(["tsconfig.json", "src/a.ts", "src/util.ts"]);
    expect(resolveImport(d, null, "@app/util", "src/a.ts", files)).toEqual(["src/util.ts"]);
    expect(resolveImport(d, null, "@app/missing", "src/a.ts", files)).toEqual([]);
  });

  it("resolves a workspace package by its package.json name", () => {
    const d = repo({
      "packages/core/package.json": JSON.stringify({ name: "@acme/core" }),
      "packages/core/src/index.ts": "export {};\n",
      "packages/core/src/deep.ts": "export {};\n",
    });
    const files = new Set(["packages/core/package.json", "packages/core/src/index.ts", "packages/core/src/deep.ts"]);
    expect(resolveImport(d, null, "@acme/core", "apps/web/a.ts", files)).toEqual(["packages/core/src/index.ts"]);
    expect(resolveImport(d, null, "@acme/core/deep", "apps/web/a.ts", files)).toEqual(["packages/core/src/deep.ts"]);
  });

  it("resolves Java FQCNs to the matching source path under any source root", () => {
    const files = new Set(["svc/src/main/java/com/app/svc/OrderService.java", "svc/src/main/java/com/app/Other.java"]);
    expect(resolveImport("/x", null, "com.app.svc.OrderService", "svc/src/main/java/com/app/A.java", files)).toEqual([
      "svc/src/main/java/com/app/svc/OrderService.java",
    ]);
  });
});

describe("unresolvedImports / isExternalImport", () => {
  it("flags well-known framework namespaces as external", () => {
    expect(isExternalImport("org.springframework.stereotype.Service")).toBe(true);
    expect(isExternalImport("java.util.List")).toBe(true);
    expect(isExternalImport("com.app.svc.OrderService")).toBe(false);
  });

  it("reports only the imports that resolve to nothing in the working tree", () => {
    const d = repo({
      "src/a.ts": `import { u } from "./util";\nimport { z } from "zod";\nimport { m } from "./missing";\n`,
      "src/util.ts": "export const u = 1;\n",
    });
    expect(unresolvedImports(d, null, "src/a.ts").sort()).toEqual(["./missing", "zod"]);
  });
});

describe("normalizeRepoPath", () => {
  it("turns Windows separators and a leading ./ into a clean posix path", () => {
    expect(normalizeRepoPath(".\\src\\a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("./src/./b/../a.ts")).toBe("src/a.ts");
  });
});
