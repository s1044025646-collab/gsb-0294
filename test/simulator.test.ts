import test from "node:test";
import assert from "node:assert/strict";
import { Simulator, Op, SimError } from "../src/simulator.js";

function makeSim(cores = 3, initial: Record<string, number> = { X: 10 }) {
  return new Simulator(cores, initial);
}

test("首次读缺失得到 E, 发 BusRd", () => {
  const sim = makeSim();
  const r = sim.execute({ op: "read", core: 0, address: "X" });
  assert.equal(r.value, 10);
  assert.deepEqual(r.events.map((e) => e.type), ["BusRd"]);
  assert.equal(r.after.lines[0], "E");
  assert.equal(r.after.lines[1], "I");
});

test("第二核心读使双方变 S", () => {
  const sim = makeSim();
  sim.execute({ op: "read", core: 0, address: "X" });
  const r = sim.execute({ op: "read", core: 1, address: "X" });
  assert.equal(r.value, 10);
  assert.equal(r.after.lines[0], "S");
  assert.equal(r.after.lines[1], "S");
});

test("共享状态下写入发 BusUpgr 并使别人失效", () => {
  const sim = makeSim();
  sim.execute({ op: "read", core: 0, address: "X" });
  sim.execute({ op: "read", core: 1, address: "X" });
  const r = sim.execute({ op: "write", core: 0, address: "X", value: 99 });
  assert.deepEqual(r.events.map((e) => e.type), ["BusUpgr"]);
  assert.equal(r.after.lines[0], "M");
  assert.equal(r.after.lines[1], "I");
  assert.equal(r.after.memory, 10); // 内存允许暂时落后
});

test("脏行被别人读取时先写回再共享最新值", () => {
  const sim = makeSim();
  sim.execute({ op: "read", core: 0, address: "X" });
  sim.execute({ op: "write", core: 0, address: "X", value: 77 });
  const r = sim.execute({ op: "read", core: 1, address: "X" });
  assert.equal(r.value, 77);
  assert.deepEqual(r.events.map((e) => e.type), ["BusRd", "WriteBack"]);
  assert.equal(r.after.memory, 77);
  assert.equal(r.after.lines[0], "S");
  assert.equal(r.after.lines[1], "S");
});

test("脏行逐出必须写回", () => {
  const sim = makeSim();
  sim.execute({ op: "read", core: 0, address: "X" });
  sim.execute({ op: "write", core: 0, address: "X", value: 55 });
  const r = sim.execute({ op: "evict", core: 0, address: "X" });
  assert.deepEqual(r.events.map((e) => e.type), ["WriteBack"]);
  assert.equal(r.after.memory, 55);
  assert.equal(r.after.lines[0], "I");
});

test("逐出 S 后剩余 S 不自动升级为 E", () => {
  const sim = makeSim();
  sim.execute({ op: "read", core: 0, address: "X" });
  sim.execute({ op: "read", core: 1, address: "X" });
  const r = sim.execute({ op: "evict", core: 0, address: "X" });
  assert.equal(r.events.length, 0);
  assert.equal(r.after.lines[1], "S");
});

test("同核心连续命中没有额外总线事件", () => {
  const sim = makeSim();
  sim.execute({ op: "read", core: 0, address: "X" });
  sim.execute({ op: "write", core: 0, address: "X", value: 1 });
  const r1 = sim.execute({ op: "read", core: 0, address: "X" });
  const r2 = sim.execute({ op: "write", core: 0, address: "X", value: 2 });
  const r3 = sim.execute({ op: "read", core: 0, address: "X" });
  assert.equal(r1.events.length, 0);
  assert.equal(r2.events.length, 0);
  assert.equal(r3.events.length, 0);
  assert.equal(r3.value, 2);
});

test("写缺失发 BusRdX 并使持有者失效", () => {
  const sim = makeSim();
  sim.execute({ op: "read", core: 0, address: "X" });
  sim.execute({ op: "write", core: 0, address: "X", value: 5 });
  const r = sim.execute({ op: "write", core: 1, address: "X", value: 6 });
  assert.deepEqual(r.events.map((e) => e.type), ["BusRdX", "WriteBack"]);
  assert.equal(r.after.lines[0], "I");
  assert.equal(r.after.lines[1], "M");
  assert.equal(r.after.values[1], 6);
});

test("不同地址互不串数据", () => {
  const sim = makeSim(2, { A: 1, B: 2 });
  sim.execute({ op: "read", core: 0, address: "A" });
  sim.execute({ op: "write", core: 0, address: "A", value: 100 });
  const r = sim.execute({ op: "read", core: 1, address: "B" });
  assert.equal(r.value, 2);
  assert.equal(r.after.lines[1], "E"); // B 只有 C1 持有
  assert.equal(sim.snapshot("A").lines[1], "I");
});

test("错误: 不存在的核心/地址/非法值/未知命令", () => {
  const sim = makeSim();
  assert.throws(() => sim.execute({ op: "read", core: 9, address: "X" }), (e: unknown) => e instanceof SimError && (e as SimError).code === "INVALID_CORE");
  assert.throws(() => sim.execute({ op: "read", core: 0, address: "ZZZ" }), (e: unknown) => e instanceof SimError && (e as SimError).code === "UNKNOWN_ADDRESS");
  assert.throws(() => sim.execute({ op: "write", core: 0, address: "X", value: 1.5 }), (e: unknown) => e instanceof SimError && (e as SimError).code === "INVALID_VALUE");
  assert.throws(() => sim.execute({ op: "boom", core: 0, address: "X" } as unknown as Op), (e: unknown) => e instanceof SimError && (e as SimError).code === "UNKNOWN_OP");
});

test("失败命令不修改状态", () => {
  const sim = makeSim();
  sim.execute({ op: "read", core: 0, address: "X" });
  const before = JSON.stringify(sim.fullState());
  assert.throws(() => sim.execute({ op: "write", core: 0, address: "X", value: Number.NaN }));
  assert.equal(JSON.stringify(sim.fullState()), before);
});

test("随机操作对照逻辑最新值模型并逐步检查不变量", () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sim = makeSim(4, { A: 0, B: 10, C: 20 });
  const model: Record<string, number> = { A: 0, B: 10, C: 20 };
  const addrs = ["A", "B", "C"];
  for (let step = 0; step < 500; step++) {
    const core = Math.floor(rand() * 4);
    const address = addrs[Math.floor(rand() * addrs.length)];
    const kind = rand();
    if (kind < 0.4) {
      const r = sim.execute({ op: "read", core, address });
      assert.equal(r.value, model[address], `step ${step}: 读 ${address} 应得 ${model[address]}`);
    } else if (kind < 0.8) {
      const value = Math.floor(rand() * 1000);
      sim.execute({ op: "write", core, address, value });
      model[address] = value;
    } else {
      sim.execute({ op: "evict", core, address });
    }
    const violations = sim.checkInvariants();
    assert.deepEqual(violations, [], `step ${step} 不变量违反`);
  }
});
