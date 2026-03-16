/**
 * Common event and message handlers for Gordian Coder
 * Platform-independent business logic
 */

import type { GordianContext, GordianEvent, Message } from "./types";

/**
 * Process incoming messages
 * This is the core message processing logic shared across all platforms
 */
export async function processMessage(
  message: Message,
  context: GordianContext
): Promise<void> {
  console.log(`[gordian-coder] Processing message:`, {
    role: message.role,
    contentLength: message.content.length,
    sessionId: context.sessionId,
  });

  // Add your custom message processing logic here
}

/**
 * Handle events from the platform
 */
export async function handleEvent(
  event: GordianEvent,
  context: GordianContext
): Promise<void> {
  console.log(`[gordian-coder] Event received:`, {
    type: event.type,
    timestamp: event.timestamp,
    sessionId: context.sessionId,
  });

  switch (event.type) {
    case "session.created":
      await onSessionCreated(context);
      break;
    case "session.ended":
      await onSessionEnded(context);
      break;
    case "message.received":
      // Handle message received event
      break;
    case "tool.executed":
      // Handle tool execution event
      break;
  }
}

/**
 * Called when a new session is created
 */
async function onSessionCreated(context: GordianContext): Promise<void> {
  console.log(`[gordian-coder] Session created: ${context.sessionId}`);
}

/**
 * Called when a session ends
 */
async function onSessionEnded(context: GordianContext): Promise<void> {
  console.log(`[gordian-coder] Session ended: ${context.sessionId}`);
}

/**
 * Hook: Before tool execution
 * Can be used to modify or validate tool inputs
 */
export async function beforeToolExecute(
  toolName: string,
  params: Record<string, unknown>,
  context: GordianContext
): Promise<Record<string, unknown>> {
  console.log(`[gordian-coder] Before tool execute: ${toolName}`);
  // Return potentially modified params
  return params;
}

/**
 * Hook: After tool execution
 * Can be used to process or modify tool outputs
 */
export async function afterToolExecute(
  toolName: string,
  result: unknown,
  context: GordianContext
): Promise<unknown> {
  console.log(`[gordian-coder] After tool execute: ${toolName}`);
  // Return potentially modified result
  return result;
}
