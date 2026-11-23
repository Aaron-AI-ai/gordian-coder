/**
 * The hooks every stage-gated slash-command workflow (pb-online, f-unit-test*, f-unittest-analysis)
 * wires the same way. Every hook is a no-op unless the session started that workflow.
 */

import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import type { CommandBeforeHook, OpenCodeModule, ToolGate } from "./modules";

export interface StageWorkflow<S extends { stage: string }> {
  COMMAND_NAME: string;
  COMMAND_DESCRIPTION: string;
  COMMAND_TEMPLATE: string;
  startSession(sessionId: string, request: string, cwd: string): unknown;
  getSession(sessionId: string): S | undefined;
  endSession(sessionId: string): void;
  gateTool(sessionId: string, tool: string, args: Record<string, unknown>): string | null;
  noteUserMessage(sessionId: string, createdAt: number): void;
  renderStageGuide(stage: NoInfer<S>["stage"], session: NoInfer<S>): string;
  takeAbortRequest?(sessionId: string): boolean;
}

type WorkflowHooks = Required<Pick<OpenCodeModule, "config" | "commandBefore" | "toolBefore" | "systemTransform" | "event">>;

export function workflowHooks<S extends { stage: string }>(
  input: PluginInput,
  wf: StageWorkflow<S>,
  opts: { keepOnOtherCommand?: boolean } = {},
): WorkflowHooks & { stopIfLooping: (sessionID: string) => void } {
  // `??=` keeps a project/global md command of the same name authoritative.
  const config: NonNullable<Hooks["config"]> = async (cfg) => {
    (cfg.command ??= {})[wf.COMMAND_NAME] ??= { description: wf.COMMAND_DESCRIPTION, template: wf.COMMAND_TEMPLATE };
  };

  const commandBefore: CommandBeforeHook = async ({ command, sessionID, arguments: raw }) => {
    if (command === wf.COMMAND_NAME) wf.startSession(sessionID, raw, input.directory);
    // Another slash command in the same session leaves this workflow; otherwise its gate would keep refusing.
    else if (!opts.keepOnOtherCommand && wf.getSession(sessionID)) wf.endSession(sessionID);
  };

  // A model that ignores "END YOUR TURN" loops until its step limit; abort the turn instead.
  const stopIfLooping = (sessionID: string): void => {
    if (!wf.takeAbortRequest?.(sessionID)) return;
    void input.client?.session.abort({ path: { id: sessionID } }).catch((err: unknown) => {
      console.error(`[gordian-coder] ${wf.COMMAND_NAME} abort(${sessionID}) failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const toolBefore: ToolGate = (toolName, sessionID, args) => {
    const rejection = wf.gateTool(sessionID, toolName, args);
    if (!rejection) return;
    stopIfLooping(sessionID);
    throw new Error(rejection);
  };

  const systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]> = async (hookInput, output) => {
    const session = wf.getSession(hookInput.sessionID);
    if (session) output.system.push(wf.renderStageGuide(session.stage, session));
  };

  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (event.type !== "message.updated" || event.properties.info.role !== "user") return;
    wf.noteUserMessage(event.properties.info.sessionID, event.properties.info.time.created);
  };

  return { config, commandBefore, toolBefore, systemTransform, event, stopIfLooping };
}
