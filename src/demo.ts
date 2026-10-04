// 演示：三个核心读写同一地址的完整 MESI 过程。
import { MesiSim, CommandResult } from "./mesi";

const sim = new MesiSim({ cores: 3, addresses: { X: 100 } });

function show(title: string, r: CommandResult): void {
  console.log(`\n=== ${title} ===`);
  const ev = r.events.length
    ? r.events.map((e) => `${e.type}(core${e.core}${e.value !== undefined ? ", value=" + e.value : ""})`).join(" -> ")
    : "(无总线事件)";
  console.log(`总线事件: ${ev}`);
  console.log(
    "核心状态: " +
      r.cores.map((c) => `core${c.core}: ${c.before}->${c.after}${c.valueAfter !== null ? " (值=" + c.valueAfter + ")" : ""}`).join("  ")
  );
  console.log(`内存: ${r.memory.before} -> ${r.memory.after}`);
  if (r.value !== undefined) console.log(`结果值: ${r.value}`);
}

console.log("初始: 内存 X=100，三个核心全部为 I");

show("1. core0 读 X（缺失 -> BusRd，独占获得 E）", sim.execute({ op: "read", core: 0, address: "X" }));
show("2. core1 读 X（BusRd，core0 降 S，双方 S）", sim.execute({ op: "read", core: 1, address: "X" }));
show("3. core2 读 X（命中前先发 BusRd，三方皆 S）", sim.execute({ op: "read", core: 2, address: "X" }));
show("4. core1 写 X=200（S -> BusUpgr 使他人失效，本地升 M）", sim.execute({ op: "write", core: 1, address: "X", value: 200 }));
show("5. core0 读 X（BusRd，core1 先写回 200 再降 S，读到最新值）", sim.execute({ op: "read", core: 0, address: "X" }));
show("6. core2 写 X=300（I -> BusRdX，他人失效，本地 M）", sim.execute({ op: "write", core: 2, address: "X", value: 300 }));
show("7. core2 逐出 X（M 必须写回内存）", sim.execute({ op: "evict", core: 2, address: "X" }));
show("8. core1 读 X（BusRd，无其他副本 -> E）", sim.execute({ op: "read", core: 1, address: "X" }));

const snap = sim.snapshot();
console.log("\n最终快照:");
console.log(JSON.stringify(snap, null, 2));
console.log(`\n不变量检查: ${sim.checkInvariants() ?? "全部通过"}`);

