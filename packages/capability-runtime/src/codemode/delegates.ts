import type {
  CodeModeDelegate,
  CodeModeDelegates,
  CodeModeInvoker,
  GeneratedFacade,
} from "./contracts.js";

function isScalar(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}

/**
 * Build runtime delegates for a generated facade. Every delegate routes
 * exclusively through the supplied invoker (the capability broker); there is
 * no provider, credential, or evidence access on this path. Arguments are
 * validated to the transport scalar shape before forwarding — required for
 * entries whose schema degraded to unknown, and harmless elsewhere because
 * the broker re-validates against the catalog.
 */
export function buildDelegates(facade: GeneratedFacade, invoker: CodeModeInvoker): CodeModeDelegates {
  const delegates: Record<string, CodeModeDelegate> = {};
  for (const entry of facade.entries) {
    const handleId = entry.handle_id;
    const operation = entry.operation;
    delegates[entry.identifier] = async (args) => {
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, reason_codes: ["invalid_argument_shape"] };
      }
      const forwarded: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(args)) {
        if (!isScalar(value)) return { ok: false, reason_codes: ["invalid_argument_type"] };
        forwarded[key] = value;
      }
      try {
        return await invoker.invoke({ handle_id: handleId, operation, arguments: forwarded });
      } catch {
        return { ok: false, reason_codes: ["broker_unavailable"] };
      }
    };
  }
  return Object.freeze(delegates);
}
