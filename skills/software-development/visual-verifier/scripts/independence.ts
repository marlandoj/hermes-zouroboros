/**
 * Verifier ≠ author check for the visual verifier.
 *
 * hermes-zouroboros: a minimal re-implementation of the author-exclusion helpers from the
 * source workspace's consensus gate (retired; not in this distribution). Pure, no network,
 * no import side effects. A model id matches another when the normalized ids are equal
 * (lowercased, a known provider scheme such as `hf:` or `openrouter:` stripped) or when their
 * basenames after the last `/` are equal, so `GLM-5.2` matches `hf:zai-org/GLM-5.2`.
 */

const PROVIDER_PREFIXES = new Set([
  "hf", "oc", "xai", "openrouter", "or", "anthropic", "openai", "google", "deepseek",
  "together", "fireworks", "groq", "synthetic", "minimax", "kimi", "nous", "custom",
]);

export function normalizeModelId(model: string): string {
  let id = (model ?? "").trim().toLowerCase();
  const colon = id.indexOf(":");
  if (colon > 0 && PROVIDER_PREFIXES.has(id.slice(0, colon))) id = id.slice(colon + 1);
  return id;
}

function modelBasename(model: string): string {
  const id = normalizeModelId(model);
  return id.slice(id.lastIndexOf("/") + 1);
}

/** True when two ids denote the same model. Empty ids never match. */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return normalizeModelId(a) === normalizeModelId(b) || modelBasename(a) === modelBasename(b);
}

/** Remove the author model (and its provider-mapped aliases) from a verifier panel. */
export function excludeAuthor(panel: string[], author?: string): string[] {
  return author ? panel.filter((model) => !sameModel(model, author)) : [...panel];
}

export type VerifierChoice = { ok: true; model: string; substituted: boolean } | { ok: false; reason: string };

/**
 * Pick the verifier model. If the requested model is the author, use the first fallback that is
 * not; with no usable fallback, refuse — a model never verifies its own deliverable.
 */
export function chooseVerifier(requested: string, author: string | undefined, fallbacks: string[] = []): VerifierChoice {
  if (!sameModel(requested, author)) return { ok: true, model: requested, substituted: false };
  const alternate = excludeAuthor(fallbacks, author)[0];
  if (alternate) return { ok: true, model: alternate, substituted: true };
  return {
    ok: false,
    reason: `verifier model '${requested}' is the author model '${author}'; a deliverable cannot be verified by the model that made it. `
      + "Choose another model with --model or VISUAL_VERIFIER_MODEL, or list alternates in VISUAL_VERIFIER_FALLBACK_MODELS.",
  };
}
