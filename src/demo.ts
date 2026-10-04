import { Simulator, Op } from "./simulator.js";

const sim = new Simulator(3, { X: 10 });

const script: Op[] = [
  { op: "read", core: 0, address: "X" },
  { op: "read", core: 1, address: "X" },
  { op: "write", core: 1, address: "X", value: 42 },
  { op: "read", core: 2, address: "X" },
  { op: "evict", core: 2, address: "X" },
  { op: "read", core: 0, address: "X" },
];

function fmtLines(s: { lines: Record<number, string>; values: Record<number, number | null>; memory: number }): string {
  const parts = Object.entries(s.lines).map(([c, st]) => `C${c}:${st}${st === "I" ? "" : `=${s.values[Number(c)]}`}`);
  return `[${parts.join(" ")}] 内存=${s.memory}`;
}

console.log("=== MESI 演示: 三个核心读写同一地址 X (初值 10) ===\n");
console.log(`初始: ${fmtLines(sim.snapshot("X"))}\n`);

for (const cmd of script) {
  const r = sim.execute(cmd);
  const desc = cmd.op === "write" ? `C${cmd.core} 写 X=${cmd.value}` : cmd.op === "read" ? `C${cmd.core} 读 X` : `C${cmd.core} 逐出 X`;
  console.log(`> ${desc}`);
  if (r.events.length > 0) {
    for (const e of r.events) {
      console.log(`  总线: ${e.type} (C${e.core})${e.value !== undefined ? ` 值=${e.value}` : ""}${e.note ? ` - ${e.note}` : ""}`);
    }
  } else {
    console.log("  总线: (无事件, 本地命中)");
  }
  if (r.value !== undefined && cmd.op === "read") console.log(`  读到: ${r.value}`);
  console.log(`  之前: ${fmtLines(r.before)}`);
  console.log(`  之后: ${fmtLines(r.after)}\n`);
}

const violations = sim.checkInvariants();
console.log(`不变量检查: ${violations.length === 0 ? "通过" : JSON.stringify(violations)}`);
