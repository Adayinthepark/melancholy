import { it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";

it("removes standalone storage without changing current agent mappings or pending requests", async () => {
  const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
    MIGRATION_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  const retirement = migrations.findIndex((m) => m.name.startsWith("0007_"));
  expect(retirement).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, retirement));
  await db.batch([
    db.prepare(
      "INSERT INTO servers(id,name,runtime,token_hash,created_at) VALUES ('server','server','codex','hash',1)",
    ),
    db.prepare(
      "INSERT INTO people(id,handle,name,kind,server_id,created_at) VALUES ('bot','bot','bot','bot','server',1)",
    ),
    db.prepare(
      "INSERT INTO threads VALUES ('old','general','old','server',1,1,0),('current','general','current','server',1,1,0)",
    ),
    db.prepare(
      "INSERT INTO agent_threads VALUES ('current','general','root','bot')",
    ),
    db.prepare(
      "INSERT INTO chat_messages(id,room_id,author_id,text,created_at) VALUES ('message','general','owner','keep',1)",
    ),
    db.prepare(
      "INSERT INTO agent_requests VALUES ('message','bot','current',0,NULL)",
    ),
    db.prepare(
      "INSERT INTO files VALUES ('file','old.txt',4,'text/plain','old',1)",
    ),
    db.prepare(
      "INSERT INTO search_messages VALUES ('old-message','old','remove')",
    ),
    db.prepare(
      "INSERT INTO agent_usage VALUES ('old-run','server',NULL,NULL,'old','codex',NULL,1,2,0,0,NULL,1,1),('current-run','server','general','root','current','codex',NULL,3,4,0,0,NULL,1,1)",
    ),
  ]);
  await applyD1Migrations(db, migrations);
  expect(
    (await db.prepare("SELECT * FROM agent_threads").all()).results,
  ).toEqual([
    {
      thread_id: "current",
      room_id: "general",
      root_id: "root",
      bot_id: "bot",
    },
  ]);
  expect(
    await db.prepare("SELECT * FROM agent_requests").first(),
  ).toMatchObject({
    thread_id: "current",
    dispatched: 0,
    message_id: "message",
  });
  expect(
    (await db.prepare("SELECT run_id FROM agent_usage").all()).results,
  ).toEqual([{ run_id: "current-run" }]);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  expect(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('channels','threads','files','search','search_messages','agent_threads_next','agent_requests_next')",
        )
        .all()
    ).results,
  ).toEqual([]);
  expect(
    await db
      .prepare("SELECT text FROM chat_search WHERE chat_search MATCH 'keep'")
      .first(),
  ).toEqual({ text: "keep" });
  await applyD1Migrations(db, migrations);
  expect(
    await db.prepare("SELECT count(*) AS count FROM agent_threads").first(),
  ).toEqual({ count: 1 });
});
