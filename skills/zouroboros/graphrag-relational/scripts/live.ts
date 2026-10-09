// Graph-backed tests need the falkordblite package and a verified Redis binary. They run only when
// GRAPHRAG_LIVE_TESTS=1; CI never downloads or compiles Redis (see runtime.ts buildRefusal).
export const LIVE = process.env.GRAPHRAG_LIVE_TESTS === "1";
export const LIVE_MARKER = "[live: GRAPHRAG_LIVE_TESTS=1, needs falkordblite + Redis]";
