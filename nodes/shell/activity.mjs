import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationFailure, Context } from '../../cruncher/activity-runtime.mjs';

const outputLimit = 64 * 1024;

export async function runShell(input) {
  const { script, shell = 'sh', environment = {}, timeoutSeconds = 60 } = input ?? {};
  if (typeof script !== 'string' || !script.trim() || script.includes('\0')
      || !['sh', 'bash'].includes(shell)
      || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300
      || !environment || typeof environment !== 'object' || Array.isArray(environment)
      || Object.entries(environment).some(([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0'))) {
    throw ApplicationFailure.nonRetryable('Invalid shell step input.', 'InvalidShellInput');
  }

  const { cancellationSignal } = Context.current();
  const workspace = await mkdtemp(join(tmpdir(), 'hoverseer-run-'));
  try {
    const output = await new Promise((resolve, reject) => {
      cancellationSignal.throwIfAborted();
      const child = spawn(`/bin/${shell}`, ['-eu', '-c', script], {
        cwd: workspace,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...environment,
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: workspace,
          TMPDIR: workspace,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      const stdout = [];
      let bytes = 0;
      let failure;
      function terminateGroup() {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      function stop(error) {
        failure ??= error;
        terminateGroup();
      }
      function count(chunk) {
        bytes += chunk.length;
        if (bytes > outputLimit) {
          stop(ApplicationFailure.nonRetryable('Shell output exceeded 64 KiB.', 'ShellOutputLimit'));
          return false;
        }
        return true;
      }
      child.stdout.on('data', chunk => {
        if (count(chunk)) stdout.push(chunk);
      });
      child.stderr.on('data', count);
      const timeout = setTimeout(() => {
        stop(ApplicationFailure.nonRetryable('Shell command timed out.', 'ShellTimeout'));
      }, timeoutSeconds * 1000);
      const cancel = () => stop(cancellationSignal.reason);
      cancellationSignal.addEventListener('abort', cancel, { once: true });
      child.once('error', () => stop(ApplicationFailure.nonRetryable('Shell could not start.', 'ShellStartFailed')));
      child.once('exit', terminateGroup);
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        cancellationSignal.removeEventListener('abort', cancel);
        if (failure) reject(failure);
        else if (code !== 0) {
          reject(ApplicationFailure.nonRetryable(`Shell exited with ${signal ?? code}.`, 'ShellCommandFailed'));
        } else {
          resolve(Buffer.concat(stdout).toString('utf8'));
        }
      });
    });
    return output;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
