/**
 * CLI adapter protocol tests.
 *
 * The server owns process.stdin/stdout and exits on shutdown, so each test
 * spawns cli.ts as a subprocess, feeds it JSON lines, and reads the JSON lines
 * it writes back — the same shape a Claude Code hook or Cline script sees.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cli.ts");

type Line = Record<string, unknown>;

function run(requests: Line[]): { lines: Line[]; status: number | null; stderr: string } {
  const input = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const result = spawnSync("bun", ["run", CLI], { input, encoding: "utf8", timeout: 20_000 });
  const lines = result.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line);
  return { lines, status: result.status, stderr: result.stderr };
}

describe("CLI adapter (JSON lines over stdio)", () => {
  it("announces itself with a ready event, answers ping, and exits on shutdown", () => {
    const { lines, status } = run([{ id: "1", action: "ping" }, { id: "2", action: "shutdown" }]);

    expect(lines[0].event).toBe("ready");
    expect(typeof lines[0].version).toBe("string");
    expect(Array.isArray(lines[0].tools)).toBe(true);

    // Responses are matched by id, not position: the shutdown ack is written
    // synchronously inside dispatch, before the awaited ping response.
    expect(lines.find((l) => l.id === "1")).toMatchObject({ ok: true, pong: true });
    expect(lines.find((l) => l.id === "2")).toMatchObject({ ok: true, message: "shutting down" });
    expect(status).toBe(0);
  });

  it("lists tools and calls one, with the response id echoed back", () => {
    const { lines } = run([
      { id: "list", action: "list_tools" },
      { id: "call", action: "call_tool", name: "echo", params: { message: "hi" } },
    ]); // no shutdown: tool calls are async and an immediate shutdown exits before they answer
    const list = lines.find((l) => l.id === "list")!;
    const call = lines.find((l) => l.id === "call")!;

    const names = (list.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("echo");
    expect(call).toEqual({ id: "call", ok: true, data: { echoed: "hi" } });
  });

  it("reports protocol errors without dying: bad JSON, missing action, unknown action, unknown tool", () => {
    const input = [
      "not json",
      JSON.stringify({ id: "a" }),
      JSON.stringify({ id: "b", action: "dance" }),
      JSON.stringify({ id: "c", action: "call_tool", name: "nope" }),
      JSON.stringify({ id: "d", action: "call_tool" }),
    ].join("\n") + "\n"; // ends with stdin close, not shutdown — see above
    const result = spawnSync("bun", ["run", CLI], { input, encoding: "utf8", timeout: 20_000 });
    const lines = result.stdout.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Line);

    expect(lines.find((l) => l.error === "Invalid JSON")).toMatchObject({ ok: false, raw: "not json" });
    expect(lines.find((l) => l.id === "a")).toMatchObject({ ok: false, error: "Missing 'action' field" });
    expect(lines.find((l) => l.id === "b")).toMatchObject({ ok: false, error: "Unknown action: dance" });
    expect((lines.find((l) => l.id === "b")!.supported as string[])).toContain("call_tool");
    expect(lines.find((l) => l.id === "c")).toMatchObject({ ok: false, error: "Tool not found: nope" });
    expect((lines.find((l) => l.id === "c")!.available as string[])).toContain("echo");
    expect(lines.find((l) => l.id === "d")).toMatchObject({ ok: false });
    expect(String(lines.find((l) => l.id === "d")!.error)).toContain("Missing 'name'");
    expect(result.status).toBe(0);
  });

  it("exits cleanly when stdin closes without a shutdown request", () => {
    const { lines, status } = run([{ id: "1", action: "ping" }]);
    expect(lines.at(-1)).toMatchObject({ id: "1", ok: true });
    expect(status).toBe(0);
  });
});
