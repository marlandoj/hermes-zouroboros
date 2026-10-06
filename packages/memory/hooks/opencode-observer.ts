/**
 * zouroboros-observer — OpenCode plugin
 *
 * Forwards OpenCode chat/tool events to the zouroboros memory-gate /observe
 * endpoint (privacy-redacted, SHA-256 deduped server-side). Adopted from the
 * agentmemory hook-capture design; never blocks the agent on failure.
 *
 * Auth: when ZO_GATE_TOKEN is set it is sent as a Bearer token (the gate
 * fails closed on protected endpoints without it, unless started with
 * --insecure). Capture failures are logged to stderr but never thrown.
 *
 * Wire via opencode.json: "plugin": ["/opt/zouroboros/repo/packages/memory/hooks/opencode-observer.ts"]
 */
import type { Plugin } from "@opencode-ai/plugin";

const GATE = process.env.ZO_GATE_URL || "http://127.0.0.1:7820";
const GATE_TOKEN = process.env.ZO_GATE_TOKEN || "";

async function observe(
  text: string,
  source: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const trimmed = (text || "").trim().slice(0, 4000);
  if (!trimmed) return;
  try {
    const res = await fetch(`${GATE}/observe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(GATE_TOKEN ? { Authorization: `Bearer ${GATE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ text: trimmed, source, ...extra }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.warn(
        `[zouroboros-observer] /observe returned ${res.status} for ${source}; event not captured`,
      );
    }
  } catch (err) {
    console.warn(`[zouroboros-observer] capture failed for ${source}: ${String(err)}`);
  }
}

export const ZouroborosObserverPlugin: Plugin = async () => {
  return {
    "chat.message": async (input) => {
      const msg = (input as { message?: { content?: unknown; role?: string } }).message;
      const text = typeof msg?.content === "string"
        ? msg.content
        : JSON.stringify({ role: msg?.role, content: msg?.content ?? null });
      const sid = (input as { sessionID?: string }).sessionID;
      await observe(text, "hook:chat-message", sid ? { sessionId: sid } : {});
    },

    "tool.execute.before": async (input) => {
      const t = input as { tool?: string; args?: unknown; sessionID?: string };
      await observe(
        JSON.stringify({ tool: t?.tool ?? "unknown", args: t?.args ?? null }),
        "hook:post-tool-use",
        {
          ...(t?.tool ? { tool: t.tool } : {}),
          ...(t?.sessionID ? { sessionId: t.sessionID } : {}),
        },
      );
    },
  };
};

export default ZouroborosObserverPlugin;
