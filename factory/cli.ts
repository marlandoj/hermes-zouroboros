#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { isPullable, pickHighestPriority, readBoardSnapshot, toTicket } from './kanban-intake.js';

export function main(args: string[]): void {
  const { values } = parseArgs({ args, options: {
    'board-dir': { type: 'string' },
    manifest: { type: 'string' },
    pullable: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  }, allowPositionals: false });
  if (values.help) {
    console.log('Usage: bun factory/cli.ts --board-dir <directory> --manifest <file> [--pullable]');
    return;
  }
  if (!values['board-dir'] || !values.manifest) {
    throw new Error('--board-dir and --manifest are required; host paths are never inferred');
  }
  const snapshot = readBoardSnapshot({ boardDir: values['board-dir'], manifestPath: values.manifest });
  if (values.pullable) {
    console.log(JSON.stringify({ board: snapshot.board, schema_sha256: snapshot.schema_sha256,
      tickets: pickHighestPriority(snapshot.tasks.filter(isPullable).map(toTicket), snapshot.tasks.length),
      dispatch_eligible: false }, null, 2));
  } else {
    console.log(JSON.stringify(snapshot, null, 2));
  }
}

if (import.meta.main) {
  try { main(Bun.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
