// R3-T04 NEGATIVE CONTROL. INTENTIONALLY FAILS. Excluded from bun test
// discovery and never run as a pass condition; CI expects exit code 1.
// Reproduces the #145 stale catch against real node:sqlite transaction data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

test("RED: original creator error after fencing transfer must not overwrite recovered owner", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE task(id TEXT PRIMARY KEY, state TEXT, generation INTEGER); " +
          "CREATE TABLE slot(id TEXT PRIMARY KEY, generation INTEGER)");
  db.prepare("INSERT INTO task VALUES(?,?,?)").run("task1","unknown",1);
  db.prepare("INSERT INTO slot VALUES(?,?)").run("task1",1);
  const grant = { id: "task1", generation: 1 };
  db.exec("UPDATE slot SET generation=2 WHERE id='task1'; " +
          "UPDATE task SET state='preparing', generation=2 WHERE id='task1'");
  // Historical #145 catch omitted a compare with grant.generation.
  db.prepare("UPDATE task SET state='failed' WHERE id=?").run(grant.id);
  assert.equal(db.prepare("SELECT state FROM task WHERE id='task1'").get().state,
    "preparing", "stale original must be fenced; historical algorithm violates this");
  db.close();
});
