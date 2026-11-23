/**
 * MCP server wiring, exercised through a real MCP client over the SDK's
 * in-memory transport — the same request/response path Claude Code uses, minus
 * the stdio pipe.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../index";
import { createReviewTools } from "../review";

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function connectedClient(): Promise<Client> {
  const server = createMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  open.push(client, server);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("");
}

describe("createMcpServer", () => {
  it("exposes every f-review tool under its own name", async () => {
    const client = await connectedClient();
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    const expected = createReviewTools().map((t) => t.name).sort();
    expect(listed).toEqual(expected);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("renders the parameter table as a JSON schema with required fields", async () => {
    const client = await connectedClient();
    const tools = (await client.listTools()).tools;
    const context = tools.find((t) => t.name === "f_review_context")!;
    const props = context.inputSchema.properties as Record<string, { type?: string }>;
    expect(props.files.type).toBe("array");
    expect(props.whole.type).toBe("boolean");
    expect(props.deepPasses.type).toBe("number");
    expect(context.inputSchema.required ?? []).toEqual([]); // all optional

    const submit = tools.find((t) => t.name === "f_review_submit")!;
    expect([...(submit.inputSchema.required ?? [])].sort()).toEqual(["assessed", "findings", "submitToken"]);
  });

  it("returns review text verbatim", async () => {
    const client = await connectedClient();

    const related = await client.callTool({ name: "related_code", arguments: {} });
    expect(related.isError ?? false).toBe(false);
    expect(text(related)).toContain("No active review");
  });

  it("rejects arguments that violate the schema instead of running the tool", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "f_review_submit", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/submitToken/);
  });
});
