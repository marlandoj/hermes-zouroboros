import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPullable, pickHighestPriority, readBoardSnapshot, tableSchemaSha256, toTicket } from '../factory/kanban-intake.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const boardDir = mkdtempSync(join(tmpdir(), 'hermes-factory-test-'));
  temporary.push(boardDir);
  const manifestPath = join(boardDir, 'manifest.json');
  const databasePath = join(boardDir, 'kanban.db');
  const db = new Database(databasePath);
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT, priority INTEGER, created_at INTEGER, claim_lock TEXT); PRAGMA user_version=1');
  const insert = db.query('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('t_00000001', ' Low priority ', null, 'ready', 1, 100, null);
  insert.run('t_00000002', 'Higher priority', 'Acceptance criteria', 'ready', 2, 200, null);
  insert.run('t_00000003', 'Already claimed', '', 'ready', 5, 50, 'worker');
  insert.run('t_00000004', 'Not ready', '', 'triage', 9, 10, null);
  const manifest = { board: 'software-factory', schema_sha256: tableSchemaSha256(db), schema_version: 1 };
  db.close();
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(boardDir, 'board.json'), JSON.stringify({ slug: 'software-factory', archived: false }));
  return { boardDir, manifestPath, databasePath, manifest };
}

describe('read-only Hermes Factory intake', () => {
  test('validates board, selects ready unclaimed tasks and preserves database bytes', () => {
    const f = fixture();
    const before = readFileSync(f.databasePath);
    const snapshot = readBoardSnapshot(f);
    expect(snapshot.tasks).toHaveLength(4);
    const tickets = pickHighestPriority(snapshot.tasks.filter(isPullable).map(toTicket), 10);
    expect(tickets.map(t => t.identifier)).toEqual(['t_00000002', 't_00000001']);
    expect(tickets[1]!.title).toBe('Low priority');
    expect(tickets[1]!.description).toBe('');
    expect(tickets[1]!.created_at).toBe('1970-01-01T00:01:40.000Z');
    expect(readFileSync(f.databasePath).equals(before)).toBe(true);
  });

  test('rejects schema drift and wrong schema version', () => {
    const f = fixture();
    writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, schema_version: 2 }));
    expect(() => readBoardSnapshot(f)).toThrow('Unqualified board schema');
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    const db = new Database(f.databasePath);
    db.exec('CREATE TABLE unauthorized_change(id TEXT)'); db.close();
    expect(() => readBoardSnapshot(f)).toThrow('Unqualified board schema');
  });

  test('rejects corrupted databases and archived boards', () => {
    const f = fixture();
    writeFileSync(f.databasePath, 'not a SQLite database');
    expect(() => readBoardSnapshot(f)).toThrow();
    writeFileSync(join(f.boardDir, 'board.json'), JSON.stringify({ slug: 'software-factory', archived: true }));
    expect(() => readBoardSnapshot(f)).toThrow('Board identity mismatch');
  });

  test('rejects malformed live task identity', () => {
    const f = fixture(); const db = new Database(f.databasePath);
    db.exec("UPDATE tasks SET id='../escape' WHERE id='t_00000001'"); db.close();
    expect(() => readBoardSnapshot(f)).toThrow('Invalid board task');
  });

  test('CLI requires both explicit paths and can read fixtures', () => {
    const cli = join(import.meta.dir, '../factory/cli.ts');
    const missing = Bun.spawnSync([process.execPath, cli], { stdout: 'pipe', stderr: 'pipe' });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain('--board-dir and --manifest are required');
    const f = fixture();
    const result = Bun.spawnSync([process.execPath, cli, '--board-dir', f.boardDir, '--manifest', f.manifestPath, '--pullable'], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.toString());
    expect(parsed.dispatch_eligible).toBe(false);
    expect(parsed.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(['t_00000002', 't_00000001']);
  });
});
