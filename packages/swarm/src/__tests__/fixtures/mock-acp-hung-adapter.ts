#!/usr/bin/env bun
/**
 * EXEC-03 regression fixture: an adapter that ignores SIGTERM/SIGINT and
 * never answers ACP requests, simulating an uncooperative adapter.
 *
 * The transport must SIGKILL it after killGraceMs and the session race must
 * settle via the explicit hard deadline — never hang forever.
 *
 * When ZO_HUNG_ADAPTER_READY is set, the fixture writes 'ready' to that path
 * AFTER installing its signal handlers, so tests can wait for the
 * uncooperative state deterministically instead of racing bun's startup.
 */
process.on('SIGTERM', () => { /* ignore: stay uncooperative */ });
process.on('SIGINT', () => { /* ignore: stay uncooperative */ });

const readyFile = process.env.ZO_HUNG_ADAPTER_READY;
if (readyFile) {
  await Bun.write(readyFile, 'ready');
}

// Hold stdin open; never speak ACP. The transport's initialize write fits in
// the pipe buffer, so the session hangs until the transport kills us.
await new Promise(() => {});
