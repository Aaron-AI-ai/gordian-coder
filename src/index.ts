import type { Plugin } from "@opencode-ai/plugin";

const GordianCoderPlugin: Plugin = async (ctx) => {
  return {
    // Tools
    tool: {},

    // Event handler
    event: async (input) => {
      const { event } = input;

      if (event.type === "session.created") {
        // Handle session creation
      }
    },

    // Hook: before tool execution
    "tool.execute.before": async (input, output) => {
      // Modify tool execution before it runs
    },

    // Hook: after tool execution
    "tool.execute.after": async (input, output) => {
      // Handle tool execution results
    },

    // Hook: chat message interceptor
    "chat.message": async (input, output) => {
      const parts = (output as { parts?: Array<{ type: string; text?: string }> }).parts;
      const messageText =
        parts
          ?.filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n")
          .trim() || "";

      console.log("[gordian-coder] Chat message received:", {
        sessionID: input.sessionID,
        message: messageText,
      });

      // Add your custom logic here
    },
  };
};

export default GordianCoderPlugin;
