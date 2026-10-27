/**
 * Runs the packaged-app smoke test (see src/main/smoke-test.ts) against the unpacked Windows
 * build in release/win-unpacked.
 *
 * Offline simulation: Chromium is pointed at a proxy on a closed local port, so any network
 * request the app attempted would fail. The app must pass without network access (PRD §3, §11).
 *
 * Usage: npm run smoke:packaged   (after `npm run package` or `npm run package:dir`)
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TIMEOUT_MS = 120_000;
const executable = resolve(import.meta.dirname, '..', 'release', 'win-unpacked', 'mmap.exe');

if (!existsSync(executable)) {
  console.error(`Packaged app not found at ${executable}. Run "npm run package:dir" first.`);
  process.exit(1);
}

const workDirectory = mkdtempSync(join(tmpdir(), 'mmap-smoke-run-'));
const reportPath = join(workDirectory, 'report.json');
// axe-core (a development dependency, not shipped) for the accessibility check.
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const child = spawn(
  executable,
  [
    '--smoke-test',
    `--smoke-report=${reportPath}`,
    `--smoke-axe=${axePath}`,
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>',
  ],
  { stdio: 'inherit', windowsHide: true },
);

const timer = setTimeout(() => {
  console.error(`Smoke test timed out after ${TIMEOUT_MS / 1000} s.`);
  child.kill();
}, TIMEOUT_MS);

child.on('exit', (code) => {
  clearTimeout(timer);
  let passed = false;
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    passed = report.passed === true && code === 0;
    for (const check of report.checks) {
      console.log(
        `${check.passed ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
      );
    }
  } else {
    console.error('The app exited without writing a smoke test report.');
  }
  rmSync(workDirectory, { recursive: true, force: true });
  console.log(
    passed ? 'Packaged smoke test passed.' : `Packaged smoke test FAILED (exit code ${code}).`,
  );
  process.exit(passed ? 0 : 1);
});
