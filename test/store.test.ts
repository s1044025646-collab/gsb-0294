import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/store.js";

test("SQLite 持久化: 重启后可继续, 重放结果一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesi-"));
  const db = path.join(dir, "t.db");

  let store = new Store(db);
  const id = store.createSim(3, { X: 1 });
  store.execute(id, { op: "read", core: 0, address: "X" });
  store.execute(id, { op: "write", core: 0, address: "X", value: 9 });
  const stateBefore = store.loadSim(id).fullState();
  store.close();

  // 模拟重启
  store = new Store(db);
  const stateAfter = store.loadSim(id).fullState();
  assert.deepEqual(stateAfter, stateBefore);
  const r = store.execute(id, { op: "read", core: 1, address: "X" });
  assert.equal(r.value, 9); // 从保存点继续, 读到最新值
  assert.equal(store.history(id).length, 3);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("批量回放与逐条执行结果一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesi-"));
  const store = new Store(path.join(dir, "t.db"));
  const id = store.createSim(2, { A: 5 });
  const results = store.executeBatch(id, [
    { op: "read", core: 0, address: "A" },
    { op: "read", core: 1, address: "A" },
    { op: "write", core: 1, address: "A", value: 8 },
  ]);
  assert.equal(results.length, 3);
  assert.equal(store.loadSim(id).snapshot("A").lines[1], "M");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
