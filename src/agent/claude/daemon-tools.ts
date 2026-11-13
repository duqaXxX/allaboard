/**
 * What the model may ask the daemon to do (`DaemonActions`), served to a session as an in-process
 * MCP server (`createSdkMcpServer`): one `allaboard` server per session, closing over that
 * session's actions, so a tool exists only for an action the core allowed. The tools are deferred
 * behind tool search, carry no annotation and no rule of ours: whether a call asks the owner is
 * the agent's own permission flow (measured 2026-11-11, SDK 0.3.322: `default` mode asks, `auto`
 * and bypass do not).
 */
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import type { DaemonActions } from "../seam.ts";

const logger = getLogger("allaboard.agent.claude.daemon-tools");

/** The server's name: the tools are offered to the model as `mcp__allaboard__<tool>`. */
export const DAEMON_SERVER = "allaboard";

// The model's line when an action threw: the error's own words may quote a path or content.
const ACTION_FAILED = "The daemon could not do that.";

/** One tool for each member of `actions` that is present, none for an empty set. */
export function daemonTools(actions: DaemonActions, signal: AbortSignal) {
  const { share } = actions;
  if (share === undefined) return [];
  return [
    tool(
      "share_file",
      "Shares a file of the session's folder into the chat thread, where the owner opens it. " +
        "Takes an absolute path or a path relative to the working folder; a file outside the " +
        "session's folder, an empty one or one over the chat's size limit is refused with the " +
        "reason.",
      {
        path: z
          .string()
          .describe("Absolute path of the file, or a path relative to the working folder"),
      },
      async ({ path }) => {
        try {
          return { content: [{ type: "text", text: await share(path, signal) }] };
        } catch (error) {
          logger.warning(`a daemon tool failed: ${errorName(error)}`);
          return { content: [{ type: "text", text: ACTION_FAILED }], isError: true };
        }
      },
      { searchHint: "share a file of the working folder into the chat thread" },
    ),
  ];
}

/** The session's server, or undefined when `actions` allows no tool. */
export function daemonServer(
  actions: DaemonActions | undefined,
  signal: AbortSignal,
): McpSdkServerConfigWithInstance | undefined {
  const tools = actions === undefined ? [] : daemonTools(actions, signal);
  return tools.length === 0 ? undefined : createSdkMcpServer({ name: DAEMON_SERVER, tools });
}
