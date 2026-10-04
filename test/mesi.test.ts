import { test } from "node:test";
import assert from "node:assert/strict";
import { MesiSim, CommandResult } from "../src/mesi";

function sim(cores = 2, addresses: Record<string, number> = { X: 10 }) {
  return new MesiSim({ cores, addresses });
}

function st(s: MesiSim, core: number, addr = "X") {
  return s.snapshot().caches[`core${core}`][addr].state;
}

test("首次读缺失得到 E，发 BusRd", () => {
  const s = sim();
  const r = s.execute({ op: "read", core: 0, address: "X" });
  assert.equal(r.value, 10);
  assert.deepEqual(r.events.map((e) => e.type), ["BusRd"]);
  assert.equal(st(s, 0), "E");
  assert.equal(st(s, 1), "I");
});

test("第二核心读使双方变 S", () => {
  const s = sim();
  s.execute({ op: "read", core: 0, address: "X" });
  const r = s.execute({ op: "read", core: 1, address: "X" });
  assert.equal(r.value, 10);
  assert.equal(st(s, 0), "S");
  assert.equal(st(s, 1), "S");
});

test("共享状态下写入发 BusUpgr 并使他人失效", () => {
  const s = sim();
  s.execute({ op: "read", core: 0, address: "X" });
  s.execute({ op: "read", core: 1, address: "X" });
  const r = s.execute({ op: "write", core: 0, address: "X", value: 42 });
  assert.deepEqual(r.events.map((e) => e.type), ["BusUpgr"]);
  assert.equal(st(s, 0), "M");
  assert.equal(st(s, 1), "I");
  assert.equal(s.snapshot().memory.X, 10); // 内存允许暂时落后
  assert.equal(s.logicalValues().X, 42);
});

test("脏行被别人读取时先写回再共享，读到最新值", () => {
  const s = sim();
  s.execute({ op: "read", core: 0, address: "X" });
  s.execute({ op: "write", core: 0, address: "X", value: 77 });
  const r = s.execute({ op: "read", core: 1, address: "X" });
  assert.equal(r.value, 77); // 不能从落后的内存返回旧值
  assert.deepEqual(r.events.map((e) => e.type), ["BusRd", "WriteBack"]);
  assert.equal(st(s, 0), "S");
  assert.equal(st(s, 1), "S");
  assert.equal(s.snapshot().memory.X, 77);
});

test("写缺失发 BusRdX，处理持有者写回并失效", () => {
  const s = sim();
  s.execute({ op: "read", core: 0, address: "X" });
  s.execute({ op: "write", core: 0, address: "X", value: 5 });
  const r = s.execute({ op: "write", core: 1, address: "X", value: 9 });
  assert.deepEqual(r.events.map((e) => e.type), ["BusRdX", "WriteBack"]);
  assert.equal(st(s, 0), "I");
  assert.equal(st(s, 1), "M");
  assert.equal(s.logicalValues().X, 9);
});

test("脏行逐出必须写回", () => {
  const s = sim();
  s.execute({ op: "read", core: 0, address: "X" });
  s.execute({ op: "write", core: 0, address: "X", value: 33 });
  const r = s.execute({ op: "evict", core: 0, address: "X" });
  assert.deepEqual(r.events.map((e) => e.type), ["WriteBack"]);
  assert.equal(s.snapshot().memory.X, 33);
  assert.equal(st(s, 0), "I");
});

test("逐出 S 只剩一个 S 时保持 S，不伪造 E", () => {
  const s = sim(3);
  s.execute({ op: "read", core: 0, address: "X" });
  s.execute({ op: "read", core: 1, address: "X" });
  s.execute({ op: "read", core: 2, address: "X" });
  s.execute({ op: "evict", core: 0, address: "X" });
  s.execute({ op: "evict", core: 1, address: "X" });
  assert.equal(st(s, 2), "S"); // 允许继续保持 S
});

test("同核心连续命中没有额外总线事件", () => {
  const s = sim();
  s.execute({ op: "read", core: 0, address: "X" }); // BusRd
  const r1 = s.execute({ op: "read", core: 0, address: "X" });
  const r2 = s.execute({ op: "write", core: 0, address: "X", value: 1 }); // E->M 静默
  const r3 = s.execute({ op: "write", core: 0, address: "X", value: 2 }); // M 命中
  const r4 = s.execute({ op: "read", core: 0, address: "X" });
  for (const r of [r1, r2, r3, r4]) assert.deepEqual(r.events, []);
});

test("不同地址互不串数据", () => {
  const s = sim(2, { A: 1, B: 2 });
  s.execute({ op: "read", core: 0, address: "A" });
  s.execute({ op: "write", core: 0, address: "A", value: 100 });
  const r = s.execute({ op: "read", core: 1, address: "B" });
  assert.equal(r.value, 2);
  assert.equal(st(s, 1, "B"), "E"); // B 无其他副本
  assert.equal(st(s, 0, "A"), "M");
  assert.equal(st(s, 0, "B"), "I");
});

test("非法命令报错且不修改状态", () => {
  const s = sim();
  s.execute({ op: "read", core: 0, address: "X" });
  const before = JSON.stringify(s.snapshot());
  assert.throws(() => s.execute({ op: "read", core: 9, address: "X" }), /核心编号/);
  assert.throws(() => s.execute({ op: "read", core: 0, address: "ZZ" }), /地址/);
  assert.throws(() => s.execute({ op: "write", core: 0, address: "X", value: 1.5 }), /整数/);
  assert.throws(() => s.execute({ op: "flush", core: 0, address: "X" } as never), /不支持的命令/);
  assert.equal(JSON.stringify(s.snapshot()), before); // 失败命令不修改状态
});

test("随机操作序列对照逻辑最新值模型并逐步检查不变量", () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 20; trial++) {
    const cores = 2 + Math.floor(rand() * 3);
    const s = sim(cores, { A: 0, B: 10, C: 20 });
    const model: Record<string, number> = { A: 0, B: 10, C: 20 };
    const addrs = ["A", "B", "C"];
    for (let step = 0; step < 200; step++) {
      const core = Math.floor(rand() * cores);
      const addr = addrs[Math.floor(rand() * addrs.length)];
      const kind = rand();
      let r: CommandResult;
      if (kind < 0.45) {
        r = s.execute({ op: "read", core, address: addr });
        assert.equal(r.value, model[addr], `trial=${trial} step=${step} 读 ${addr}`);
      } else if (kind < 0.85) {
        const v = Math.floor(rand() * 1000);
        r = s.execute({ op: "write", core, address: addr, value: v });
        model[addr] = v;
      } else {
        r = s.execute({ op: "evict", core, address: addr });
      }
      assert.equal(s.checkInvariants(), null, `trial=${trial} step=${step} 不变量`);
      assert.deepEqual(s.logicalValues(), model, `trial=${trial} step=${step} 逻辑值`);
    }
  }
});
