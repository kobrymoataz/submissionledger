import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));

function runCli(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

function withTemporaryDirectory(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'submissionledger-cli-'));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('CLI shows its version and available commands', () => {
  withTemporaryDirectory((cwd) => {
    assert.equal(runCli(cwd, '--version').stdout.trim(), '0.1.0');
    assert.match(runCli(cwd, 'help').stdout, /submissionledger submit/);
  });
});

test('CLI initializes, accepts, lists and retrieves an application', () => {
  withTemporaryDirectory((cwd) => {
    writeFileSync(join(cwd, 'application.json'), JSON.stringify({ applicant: 'Sam', status: 'new' }));
    assert.equal(runCli(cwd, 'init').status, 0);
    const accepted = runCli(cwd, 'submit', '--file', 'application.json', '--source', 'website', '--key', 'app-001', '--json');
    assert.equal(accepted.status, 0, accepted.stderr);
    const first = JSON.parse(accepted.stdout) as { outcome: string; submission: { id: string } };
    assert.equal(first.outcome, 'accepted');
    const replay = runCli(cwd, 'submit', '--file', 'application.json', '--source', 'website', '--key', 'app-001', '--json');
    assert.equal((JSON.parse(replay.stdout) as { outcome: string }).outcome, 'replayed');
    const listed = runCli(cwd, 'list', '--source', 'website', '--json');
    assert.equal((JSON.parse(listed.stdout) as unknown[]).length, 1);
    assert.equal(runCli(cwd, 'get', first.submission.id, '--json').status, 0);
    assert.match(runCli(cwd, 'stats').stdout, /Submissions:\s+1/);
  });
});

test('CLI gives a distinct exit code for an idempotency conflict', () => {
  withTemporaryDirectory((cwd) => {
    assert.equal(runCli(cwd, 'init').status, 0);
    assert.equal(runCli(cwd, 'submit', '--data', '{"n":1}', '--key', 'x').status, 0);
    const conflicting = runCli(cwd, 'submit', '--data', '{"n":2}', '--key', 'x');
    assert.equal(conflicting.status, 3);
    assert.match(conflicting.stderr, /different payload/);
  });
});

test('CLI does not create a database on a read-only command', () => {
  withTemporaryDirectory((cwd) => {
    const result = runCli(cwd, 'list');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Run 'submissionledger init' first/);
  });
});

test('CLI rejects invalid options and invalid JSON', () => {
  withTemporaryDirectory((cwd) => {
    assert.equal(runCli(cwd, 'init').status, 0);
    assert.equal(runCli(cwd, 'submit', '--data', '{').status, 2);
    assert.equal(runCli(cwd, 'submit', '--data', '{}', '--file', 'x').status, 2);
    assert.equal(runCli(cwd, 'list', '--limit', '0').status, 2);
    assert.equal(runCli(cwd, 'list', '--unknown').status, 2);
  });
});
