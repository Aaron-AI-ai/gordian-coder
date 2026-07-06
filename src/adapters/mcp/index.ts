/**
 * MCP Server Adapter
 * Bridges core logic with Model Context Protocol (MCP)
 * Works with: Claude Code, Cline, and other MCP-compatible tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getAllTools,
  type ToolDefinition,
  type ParameterDefinition,
} from "../../core";
import { createReviewTools } from "./review";

/**
 * Convert core parameter type to Zod schema
 */
function parameterToZod(param: ParameterDefinition): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  switch (param.type) {
    case "string":
      schema = z.string().describe(param.description);
      break;
    case "number":
      schema = z.number().describe(param.description);
      break;
    case "boolean":
      schema = z.boolean().describe(param.description);
      break;
    case "object":
      schema = z.record(z.unknown()).describe(param.description);
      break;
    case "array":
      schema = z.array(z.unknown()).describe(param.description);
      break;
    default:
      schema = z.unknown();
  }

  if (!param.required) {
    schema = schema.optional();
    if (param.default !== undefined) {
      schema = schema.default(param.default);
    }
  }

  return schema;
}

/**
 * Convert core tool to MCP tool schema shape
 */
function toolToMcpShape(tool: ToolDefinition): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, param] of Object.entries(tool.parameters)) {
    shape[key] = parameterToZod(param);
  }

  return shape;
}

/**
 * Tool handler type
 */
type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

/**
 * Create and configure MCP server
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "gordian-coder",
    version: "0.1.0",
  });

  // Register all core tools + the review tools as MCP tools
  for (const coreTool of [...getAllTools(), ...createReviewTools()]) {
    const shape = toolToMcpShape(coreTool);
    const toolName = coreTool.name;

    const handler: ToolHandler = async (params) => {
      try {
        const result = await coreTool.execute(params);

        if (result.success) {
          return {
            content: [
              {
                type: "text" as const,
                // Plain-text results (review tools) pass through unescaped.
                text:
                  typeof result.data === "string"
                    ? result.data
                    : JSON.stringify(result.data, null, 2),
              },
            ],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: result.error || "Unknown error" }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    };

    // Use type assertion to bypass deep type instantiation issue
    (server.tool as Function)(toolName, coreTool.description, shape, handler);
  }

  return server;
}

/**
 * Start MCP server with stdio transport
 * This is the main entry point when running as MCP server
 */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  console.error("[gordian-coder] Starting MCP server...");

  await server.connect(transport);

  console.error("[gordian-coder] MCP server connected and ready");
}

// Auto-start if this file is run directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  startMcpServer().catch(console.error);
}
