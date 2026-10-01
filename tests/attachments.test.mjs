import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { downloadAttachments } from "../packages/connector/attachments.mjs";

async function fixture(t, handler, overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "melancholy-download-"));
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  const job = {
    id: randomUUID(),
    attachments: [{ id: randomUUID(), name: "apartment (2).html", size: 4 }],
  };
  const events = [];
  return {
    job,
    events,
    dir: join(stateDir, "attachments", job.id),
    run: (options = {}) =>
      downloadAttachments(job, {
        stateDir,
        base: `http://127.0.0.1:${server.address().port}`,
        token: "test-server-token",
        timeoutMs: 1000,
        retryDelays: [1, 1],
        onActivity: (event) => {
          events.push(event);
        },
        ...overrides,
        ...options,
      }),
  };
}

test("attachment downloads retry transient HTTP failures and save complete private files", async (t) => {
  let attempts = 0;
  const f = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-server-token");
    attempts++;
    if (attempts === 1) res.writeHead(503).end("unavailable");
    else res.end("html");
  });
  const [path] = await f.run();
  assert.equal(attempts, 2);
  assert.equal(await readFile(path, "utf8"), "html");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readdir(f.dir)).length, 1);
  assert(f.events.some((e) => e.detail.includes("Retrying")));
  assert.equal(f.events.at(-1).status, "completed");
});

test("attachment timeouts cover a stalled body and retry without partial files", async (t) => {
  let attempts = 0;
  const f = await fixture(
    t,
    (_req, res) => {
      if (++attempts === 1) {
        res.writeHead(200);
        res.write("h");
      } else res.end("html");
    },
    { timeoutMs: 100 },
  );
  const [path] = await f.run();
  assert.equal(attempts, 2);
  assert.equal(await readFile(path, "utf8"), "html");
  assert(f.events.some((e) => e.detail.includes("timed out")));
  assert.equal((await readdir(f.dir)).length, 1);
});

test("truncated attachments retry and exhausted failures identify the file before startup", async (t) => {
  let attempts = 0;
  const f = await fixture(t, (_req, res) => {
    attempts++;
    res.end("h");
  });
  await assert.rejects(
    f.run(),
    /apartment \(2\)\.html.*3 attempt.*incomplete.*agent did not start/,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(await readdir(f.dir), []);
  assert.equal(f.events.at(-1).status, "failed");
});

for (const status of [401, 403, 404])
  test(`HTTP ${status} is not retried or saved`, async (t) => {
    let attempts = 0;
    const f = await fixture(t, (_req, res) => {
      attempts++;
      res.writeHead(status).end();
    });
    await assert.rejects(f.run(), new RegExp(`apartment.*HTTP ${status}`));
    assert.equal(attempts, 1);
    assert.deepEqual(await readdir(f.dir), []);
  });

test("Stop aborts an in-progress attachment and never retries", async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let attempts = 0;
  const f = await fixture(t, (_req, res) => {
    attempts++;
    res.write("h");
    started();
  });
  const controller = new AbortController();
  const result = f.run({ signal: controller.signal });
  const rejected = assert.rejects(result, { name: "AbortError" });
  await ready;
  controller.abort();
  await rejected;
  assert.equal(attempts, 1);
  assert.deepEqual(await readdir(f.dir), []);
});

test("oversized streaming bodies are rejected without retry or writing partial files", async (t) => {
  let attempts = 0;
  const f = await fixture(t, (_req, res) => {
    attempts++;
    res.write(Buffer.alloc(10 * 1024 * 1024 + 1));
    res.end();
  });
  await assert.rejects(f.run(), /exceeds 10 MB/);
  assert.equal(attempts, 1);
  assert.deepEqual(await readdir(f.dir), []);
});

test("attachment redirects cannot forward the server credential to another endpoint", async (t) => {
  let forwarded = 0;
  const f = await fixture(t, (req, res) => {
    if (req.url === "/elsewhere") {
      forwarded++;
      res.end("html");
    } else res.writeHead(302, { Location: "/elsewhere" }).end();
  });
  await assert.rejects(f.run(), /Network interrupted/);
  assert.equal(forwarded, 0);
});
