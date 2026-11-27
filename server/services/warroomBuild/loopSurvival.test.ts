import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

const MISSING_TABLE = JSON.stringify({
  code: 'PGRST205',
  message: "Could not find the table 'public.warroom_builds' in the schema cache",
  details: null,
  hint: null,
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/**
 * Boots the real server the way Render does: flag and worker on, migration 267
 * not applied. The process must still be alive after the first claim interval.
 */
test(
  'the server stays up when durable builds are on and the schema is missing',
  { timeout: 30_000 },
  async () => {
    const fake = createServer((_req, res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(MISSING_TABLE);
    });
    const apiPort = await listen(fake);
    const app = createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    const appPort = await listen(app);

    const childEnv = { ...process.env };
    delete childEnv.RENDER;
    delete childEnv.VERCEL;
    childEnv.NODE_ENV = 'development';
    childEnv.PORT = String(appPort);
    childEnv.SUPABASE_URL = `http://127.0.0.1:${apiPort}`;
    childEnv.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-placeholder-not-a-key';
    childEnv.WARROOM_DURABLE_BUILDS = 'true';
    childEnv.WARROOM_BUILD_WORKER = 'true';
    childEnv.WARROOM_BUILD_POLL_MS = '200';
    childEnv.RUN_BACKGROUND_ENGINES = 'false';
    childEnv.LOG_LEVEL = 'info';

    // The port above is held by `app` only so we know it is free. Release it
    // before the server binds the same port.
    await new Promise<void>((resolve, reject) =>
      app.close((err) => (err ? reject(err) : resolve())),
    );

    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    try {
      const started = Date.now();
      while (!output.includes('Server started successfully') && child.exitCode == null) {
        if (Date.now() - started > 15_000) {
          throw new Error(`server did not start\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(child.exitCode, null, output);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(child.exitCode, null, output);
      assert.equal(output.includes('ERR_UNHANDLED_REJECTION'), false, output);
      assert.equal(output.includes('warroom_durable_builds_unavailable'), true, output);
    } finally {
      if (child.exitCode == null) child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (child.exitCode != null) resolve();
        else child.once('exit', () => resolve());
      });
      await new Promise<void>((resolve, reject) =>
        fake.close((err) => (err ? reject(err) : resolve())),
      );
    }
  },
);
