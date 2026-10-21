import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acceptSubmission } from '../ledger/submissions.js';
import { exportLedger } from '../ledger/export.js';
import { verifyLedger } from '../ledger/verification.js';
import { initializeLedger } from '../storage/sqlite.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));

function withTemporaryLedger(run: (path: string, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'submissionledger-audit-'));
  const path = join(directory, 'ledger.sqlite');
  try {
    initializeLedger(path);
    run(path, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a new ledger with multiple submissions passes integrity checks', () => {
  withTemporaryLedger((path) => {
    for (let i = 1; i <= 3; i += 1) {
      acceptSubmission(path, { payload: { number: i }, idempotencyKey: `entry-${i}` });
    }
    const result = verifyLedger(path);
    assert.equal(result.ok, true);
    assert.equal(result.submissions, 3);
    assert.equal(result.events, 3);
    assert.deepEqual(result.issues, []);
  });
});

test('editing a stored payload is detected', () => {
  withTemporaryLedger((path) => {
    acceptSubmission(path, { payload: { decision: 'pending' } });
    const db = new DatabaseSync(path);
    try {
      db.prepare('UPDATE submissions SET payload_json = ?').run('{"decision":"approved"}');
    } finally {
      db.close();
    }
    const result = verifyLedger(path);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'payload_hash'));
  });
});

test('editing an event hash breaks the link to later events', () => {
  withTemporaryLedger((path) => {
    acceptSubmission(path, { payload: { number: 1 } });
    acceptSubmission(path, { payload: { number: 2 } });
    const db = new DatabaseSync(path);
    try {
      db.prepare('UPDATE events SET hash = ? WHERE seq = 1').run('0'.repeat(64));
    } finally {
      db.close();
    }
    const result = verifyLedger(path);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'event_hash'));
    assert.ok(result.issues.some((issue) => issue.code === 'event_chain'));
  });
});

test('a missing acceptance event is detected', () => {
  withTemporaryLedger((path) => {
    acceptSubmission(path, { payload: { number: 1 } });
    const db = new DatabaseSync(path);
    try {
      db.exec('DELETE FROM events');
    } finally {
      db.close();
    }
    const result = verifyLedger(path);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'event_count'));
  });
});

test('exports verified records and refuses to overwrite an export', () => {
  withTemporaryLedger((path, directory) => {
    const saved = acceptSubmission(path, { payload: { applicant: 'Sam' } });
    const output = join(directory, 'backups', 'snapshot.jsonl');
    const result = exportLedger(path, output);
    assert.equal(result.submissions, 1);
    assert.equal(result.events, 1);
    const rows = readFileSync(output, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string; id?: string });
    assert.deepEqual(rows.map((row) => row.kind), ['manifest', 'submission', 'event']);
    assert.equal(rows[1]?.id, saved.submission.id);
    assert.throws(() => exportLedger(path, output), /EEXIST/);
    if (process.platform !== 'win32') assert.equal(statSync(output).mode & 0o077, 0);
    chmodSync(output, 0o600);
  });
});

test('CLI verify returns an error code on corruption', () => {
  withTemporaryLedger((path, directory) => {
    acceptSubmission(path, { payload: { value: 1 } });
    const verified = spawnSync(process.execPath, [cli, 'verify', '--db', path, '--json'], { cwd: directory, encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal((JSON.parse(verified.stdout) as { ok: boolean }).ok, true);
    const db = new DatabaseSync(path);
    try {
      db.prepare('UPDATE events SET data_json = ?').run('{}');
    } finally {
      db.close();
    }
    const corrupted = spawnSync(process.execPath, [cli, 'verify', '--db', path, '--json'], { cwd: directory, encoding: 'utf8' });
    assert.equal(corrupted.status, 1);
    assert.equal((JSON.parse(corrupted.stdout) as { ok: boolean }).ok, false);
  });
});

test('an unverified ledger cannot be exported', () => {
  withTemporaryLedger((path, directory) => {
    acceptSubmission(path, { payload: { value: 1 } });
    const db = new DatabaseSync(path);
    try {
      db.exec('DELETE FROM events');
    } finally {
      db.close();
    }
    assert.throws(() => exportLedger(path, join(directory, 'backup.jsonl')), /Integrity check failed/);
  });
});
