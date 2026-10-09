#!/usr/bin/env node
// Translates Kimi Code, Gemini CLI and Hermes hook events into the Claude Code shape Canny
// reads, and (with --out) Canny's verdicts back into each harness's decision format for live mode.
// Kimi and Gemini shapes were captured from live sessions (kimi 0.41.0, gemini 0.58.0); the
// Hermes shapes follow its shell-hook wire protocol (hermes-agent agent/shell_hooks.py).
//   adapter.mjs <kimi|gemini|hermes>          event in, Claude-shaped event out
//   adapter.mjs --out <kimi|gemini|hermes>    {event, verdict} in, harness decision out
import { readFileSync } from "node:fs";

const outMode = process.argv[2] === "--out";
const harness = process.argv[outMode ? 3 : 2];
const raw = JSON.parse(readFileSync(0, "utf8") || "{}");
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === "string" ? v : "");

const EXIT = /exit(?:ed)?(?: with)?(?: code)?:?\s*(-?\d+)/i;

function kimi(e) {
  const out = { ...e, session_id: `kimi-${str(e.session_id) || "unknown"}` };
  const ti = { ...obj(e.tool_input) };
  if (ti.path !== undefined && ti.file_path === undefined) ti.file_path = ti.path;
  out.tool_input = ti;
  if (e.hook_event_name === "PostToolUse") {
    out.tool_response = { stdout: str(e.tool_output), exit_code: 0 };
  } else if (e.hook_event_name === "PostToolUseFailure") {
    const err = obj(e.error);
    const message = str(err.message) || str(e.error);
    const m = message.match(EXIT);
    out.error = m ? `Exit code ${m[1]}\n${message}` : message;
  } else if (e.hook_event_name === "Stop") {
    out.last_assistant_message = str(e.last_assistant_message);
  }
  return out;
}

const GEMINI_EVENTS = {
  SessionStart: "SessionStart",
  BeforeTool: "PreToolUse",
  AfterTool: "PostToolUse",
  AfterAgent: "Stop",
};

function gemini(e) {
  const event = GEMINI_EVENTS[str(e.hook_event_name)] ?? str(e.hook_event_name);
  const ti = obj(e.tool_input);
  const out = {
    hook_event_name: event,
    session_id: `gemini-${str(e.session_id) || "unknown"}`,
    cwd: str(e.cwd),
    tool_name: str(e.tool_name),
    tool_input: ti,
  };
  switch (e.tool_name) {
    case "write_file":
      out.tool_name = "Write";
      out.tool_input = { file_path: str(ti.file_path), content: str(ti.content) };
      break;
    case "replace":
      out.tool_name = "Edit";
      out.tool_input = {
        file_path: str(ti.file_path),
        old_string: str(ti.old_string),
        new_string: str(ti.new_string),
      };
      break;
    case "run_shell_command":
      out.tool_name = "Bash";
      out.tool_input = { command: str(ti.command) };
      if (str(ti.dir_path)) out.cwd = str(ti.dir_path);
      break;
  }
  if (event === "PostToolUse") {
    const r = obj(e.tool_response);
    const text = str(r.llmContent) || str(e.tool_response);
    const m = text.match(/Exit Code:\s*(-?\d+)/);
    const failed = r.error !== undefined && r.error !== null;
    out.tool_response = { stdout: text, exit_code: m ? Number(m[1]) : failed ? 1 : 0 };
  }
  if (event === "Stop") {
    out.last_assistant_message = str(e.prompt_response);
    out.stop_hook_active = e.stop_hook_active === true;
  }
  return out;
}

// Hermes shell hooks send {hook_event_name, tool_name, tool_input, session_id, cwd, extra} with
// snake_case events and Hermes tool names: terminal {command, workdir}, write_file {path, content},
// patch {path, old_string, new_string} or patch {mode: "patch", patch: <V4A text>}.
const HERMES_EVENTS = {
  on_session_start: "SessionStart",
  pre_tool_call: "PreToolUse",
  post_tool_call: "PostToolUse",
  pre_verify: "Stop",
};

function hermes(e) {
  const event = HERMES_EVENTS[str(e.hook_event_name)] ?? str(e.hook_event_name);
  const ti = obj(e.tool_input);
  const x = obj(e.extra);
  const out = {
    hook_event_name: event,
    session_id: `hermes-${str(e.session_id) || "unknown"}`,
    cwd: str(e.cwd),
    tool_name: str(e.tool_name),
    tool_input: ti,
  };
  switch (e.tool_name) {
    case "terminal":
      out.tool_name = "Bash";
      out.tool_input = { command: str(ti.command) };
      if (str(ti.workdir)) out.cwd = str(ti.workdir);
      break;
    case "write_file":
      out.tool_name = "Write";
      out.tool_input = { file_path: str(ti.path), content: str(ti.content) };
      break;
    case "patch": {
      // A V4A patch carries its own target and body; expose both so the secret scan sees it.
      const body = str(ti.patch);
      const target = body.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
      out.tool_name = "Edit";
      out.tool_input = {
        file_path: str(ti.path) || (target ? target[1].trim() : ""),
        old_string: str(ti.old_string),
        new_string: str(ti.new_string) || body,
      };
      break;
    }
  }
  if (event === "PostToolUse") {
    // extra.result is the tool's serialized return; terminal returns {output, exit_code, error}.
    const text = str(x.result);
    let r = {};
    try { r = obj(JSON.parse(text)); } catch {}
    const failed = str(x.status) === "error" || (r.error !== undefined && r.error !== null && r.error !== "");
    out.tool_response = {
      stdout: str(r.output) || text,
      exit_code: Number.isInteger(r.exit_code) ? r.exit_code : failed ? 1 : 0,
    };
  }
  if (event === "Stop") {
    out.last_assistant_message = str(x.final_response);
    out.stop_hook_active = Number(x.attempt) > 0;
  }
  return out;
}

// Kimi blocks only on exit 2 or hookSpecificOutput.permissionDecision "deny"; a Stop block is fed
// back to the model as a user message once. It has no ask, input rewrite, or context injection.
function kimiOut(v) {
  const h = obj(v.hookSpecificOutput);
  const deny = (reason) => ({
    hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason },
  });
  if (v.decision === "block") return deny(str(v.reason) || str(v.systemMessage));
  if (h.permissionDecision === "deny" || h.permissionDecision === "ask")
    return deny(str(h.permissionDecisionReason) || str(v.systemMessage));
  const msg = str(h.additionalContext) || str(v.systemMessage);
  return msg ? { message: msg } : {};
}

// Gemini reads a top-level decision (block/deny/ask) and reason; AfterAgent "block" makes the
// agent continue with the reason as its next prompt. BeforeTool rewrites via hookSpecificOutput.tool_input.
function geminiOut(v, e) {
  const h = obj(v.hookSpecificOutput);
  const base = v.systemMessage ? { systemMessage: str(v.systemMessage) } : {};
  if (v.decision === "block") return { ...base, decision: "block", reason: str(v.reason) };
  if (h.permissionDecision === "deny" || h.permissionDecision === "ask")
    return { ...base, decision: h.permissionDecision, reason: str(h.permissionDecisionReason) };
  if (h.updatedInput) {
    const ti = { ...obj(e.tool_input), command: str(obj(h.updatedInput).command) };
    return { ...base, hookSpecificOutput: { tool_input: ti, additionalContext: str(h.additionalContext) } };
  }
  if (h.additionalContext) return { ...base, hookSpecificOutput: { additionalContext: str(h.additionalContext) } };
  return base;
}

// Hermes honours {"decision":"block","reason"} on pre_tool_call (refuse the call) and on
// pre_verify (keep the agent going with the reason), and {"action":"modify","args"} on
// pre_tool_call. It ignores post_tool_call output and injects context only on pre_llm_call, so
// notes and warnings are dropped. There is no ask: an ask becomes a block, as for Kimi.
function hermesOut(v, e) {
  const h = obj(v.hookSpecificOutput);
  const event = str(e.hook_event_name);
  const block = (reason) => ({ decision: "block", reason: reason || "Verity refused this step" });
  if (event === "pre_verify") return v.decision === "block" ? block(str(v.reason) || str(v.systemMessage)) : {};
  if (event !== "pre_tool_call") return {};
  if (v.decision === "block") return block(str(v.reason) || str(v.systemMessage));
  if (h.permissionDecision === "deny" || h.permissionDecision === "ask")
    return block(str(h.permissionDecisionReason) || str(v.systemMessage));
  const command = str(obj(h.updatedInput).command);
  if (command && e.tool_name === "terminal") return { action: "modify", args: { ...obj(e.tool_input), command } };
  return {};
}

if (outMode) {
  const translate = { kimi: kimiOut, gemini: geminiOut, hermes: hermesOut }[harness];
  const v = obj(raw.verdict);
  process.stdout.write(JSON.stringify(translate ? translate(v, obj(raw.event)) : v));
} else {
  const convert = { kimi, gemini, hermes }[harness];
  process.stdout.write(JSON.stringify(convert ? convert(raw) : raw));
}
