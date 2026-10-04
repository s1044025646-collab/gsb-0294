import path from "node:path";
import fs from "node:fs";
import { Store } from "./store.js";
import { SimError } from "./simulator.js";
import { parseCommand } from "./validate.js";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });
const store = new Store(path.join(dataDir, "mesi.db"));

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseAddresses(pairs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq <= 0) throw new SimError("BAD_REQUEST", `地址初值格式应为 地址=整数, 收到: ${p}`);
    const addr = p.slice(0, eq);
    const v = Number(p.slice(eq + 1));
    if (!Number.isInteger(v)) throw new SimError("INVALID_VALUE", `初值必须是整数: ${p}`);
    out[addr] = v;
  }
  return out;
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "create": {
      const cores = Number(argValue("--cores") ?? "2");
      const addrPairs: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--addr") addrPairs.push(rest[++i]);
      }
      if (addrPairs.length === 0) throw new SimError("BAD_REQUEST", "至少需要一个 --addr 地址=初值");
      const id = store.createSim(cores, parseAddresses(addrPairs));
      print({ id, state: store.loadSim(id).fullState() });
      break;
    }
    case "list":
      print({ sims: store.listSims() });
      break;
    case "exec": {
      const sim = Number(argValue("--sim"));
      const positional = rest.filter((a, i) => a !== "--sim" && (i === 0 || rest[i - 1] !== "--sim"));
      const [op, coreStr, address, valueStr] = positional;
      const raw: Record<string, unknown> = { op, core: Number(coreStr), address };
      if (op === "write") raw.value = Number(valueStr);
      print(store.execute(sim, parseCommand(raw)));
      break;
    }
    case "batch": {
      const sim = Number(argValue("--sim"));
      const file = argValue("--file");
      if (!file) throw new SimError("BAD_REQUEST", "batch 需要 --file <json>");
      const cmds = (JSON.parse(fs.readFileSync(file, "utf8")) as unknown[]).map(parseCommand);
      print({ results: store.executeBatch(sim, cmds) });
      break;
    }
    case "state":
      print({ state: store.loadSim(Number(argValue("--sim"))).fullState() });
      break;
    case "check": {
      const violations = store.loadSim(Number(argValue("--sim"))).checkInvariants();
      print({ ok: violations.length === 0, violations });
      break;
    }
    case "history":
      print({ history: store.history(Number(argValue("--sim"))) });
      break;
    case "events": {
      const events = store.history(Number(argValue("--sim"))).flatMap((h) =>
        h.result.events.map((e) => ({ seq: h.seq, ...e }))
      );
      print({ events });
      break;
    }
    case "export": {
      const sim = Number(argValue("--sim"));
      const history = store.history(sim);
      print({
        simId: sim,
        state: store.loadSim(sim).fullState(),
        commands: history.map((h) => h.command),
        events: history.flatMap((h) => h.result.events.map((e) => ({ seq: h.seq, ...e }))),
      });
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令> [参数]
  create --cores N --addr X=0 [--addr Y=1 ...]   创建模拟
  list                                          列出所有模拟
  exec --sim ID <read|write|evict> CORE ADDR [VALUE]  执行单条命令
  batch --sim ID --file cmds.json               批量回放
  state --sim ID                                查看缓存与内存
  check --sim ID                                检查不变量
  history --sim ID                              查看历史
  events --sim ID                               查看总线事件
  export --sim ID                               导出全部数据`);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof SimError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    process.exit(1);
  }
  throw err;
} finally {
  store.close();
}
