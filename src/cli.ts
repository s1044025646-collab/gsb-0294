// CLI：创建模拟、逐条执行、批量回放、查看状态/历史、检查不变量、导出事件。
import path from "node:path";
import fs from "node:fs";
import { SimStore } from "./store";
import { MesiSim, SimError, SimConfig } from "./mesi";

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.MESI_DB ?? path.join(DATA_DIR, "mesi.db");

function usage(): void {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
  create --cores 3 --addr X=0 --addr Y=10        创建模拟，输出 id
  exec <id> read <core> <addr>                   执行读
  exec <id> write <core> <addr> <value>          执行写
  exec <id> evict <core> <addr>                  显式逐出
  replay <id> <commands.json>                    批量回放（JSON 数组）
  state <id>                                     查看缓存与内存
  check <id>                                     检查不变量并重放核对
  history <id>                                   查看命令历史
  export <id>                                    导出全部总线事件
  list                                           列出所有模拟
环境变量 MESI_DB 可指定数据库文件，默认 data/mesi.db`);
}

function parseIntArg(s: string, what: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new SimError("INVALID_VALUE", `${what} 必须是整数，收到: ${s}`);
  return n;
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function main(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = new SimStore(DB_PATH);
  const args = process.argv.slice(2);
  const cmd = args[0];
  try {
    switch (cmd) {
      case "create": {
        let cores = 0;
        const addresses: Record<string, number> = {};
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--cores") cores = parseIntArg(args[++i], "核心数");
          else if (args[i] === "--addr") {
            const kv = args[++i];
            const eq = kv.indexOf("=");
            if (eq <= 0) throw new SimError("BAD_REQUEST", `--addr 需要 名称=初值，收到: ${kv}`);
            addresses[kv.slice(0, eq)] = parseIntArg(kv.slice(eq + 1), `地址 ${kv.slice(0, eq)} 初值`);
          } else throw new SimError("BAD_REQUEST", `未知参数: ${args[i]}`);
        }
        const config: SimConfig = { cores, addresses };
        new MesiSim(config); // 校验
        const id = store.createSim(config);
        print({ id, config });
        break;
      }
      case "exec": {
        const id = parseIntArg(args[1], "模拟 id");
        const op = args[2];
        let command: unknown;
        if (op === "read" || op === "evict") {
          command = { op, core: parseIntArg(args[3], "核心编号"), address: args[4] };
        } else if (op === "write") {
          command = { op, core: parseIntArg(args[3], "核心编号"), address: args[4], value: parseIntArg(args[5], "写入值") };
        } else {
          throw new SimError("UNKNOWN_COMMAND", `不支持的命令: ${op}`);
        }
        const sim = store.loadSim(id);
        try {
          const result = sim.execute(command);
          store.appendCommand(id, command, result);
          print(result);
        } catch (e) {
          if (e instanceof SimError) {
            store.appendCommand(id, command, null, { code: e.code, message: e.message });
          }
          throw e;
        }
        break;
      }
      case "replay": {
        const id = parseIntArg(args[1], "模拟 id");
        const file = args[2];
        if (!file) throw new SimError("BAD_REQUEST", "replay 需要命令文件路径");
        const commands = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
        if (!Array.isArray(commands)) throw new SimError("BAD_REQUEST", "命令文件必须是 JSON 数组");
        const sim = store.loadSim(id);
        const results: unknown[] = [];
        for (const c of commands) {
          try {
            const r = sim.execute(c);
            store.appendCommand(id, c, r);
            results.push(r);
          } catch (e) {
            if (e instanceof SimError) {
              store.appendCommand(id, c, null, { code: e.code, message: e.message });
              results.push({ ok: false, error: { code: e.code, message: e.message } });
            } else throw e;
          }
        }
        print({ ok: true, results });
        break;
      }
      case "state": {
        const id = parseIntArg(args[1], "模拟 id");
        const sim = store.loadSim(id);
        print({ id, ...sim.snapshot(), logicalValues: sim.logicalValues() });
        break;
      }
      case "check": {
        const id = parseIntArg(args[1], "模拟 id");
        const sim = store.loadSim(id);
        const violation = sim.checkInvariants();
        const replay = store.verifyReplay(id);
        print({ ok: violation === null && replay.ok, invariant: violation ?? "ok", replay: replay.detail });
        break;
      }
      case "history": {
        const id = parseIntArg(args[1], "模拟 id");
        store.getConfig(id);
        print({ id, history: store.history(id) });
        break;
      }
      case "export": {
        const id = parseIntArg(args[1], "模拟 id");
        const sim = store.loadSim(id);
        const events = store
          .history(id)
          .flatMap((h) => (h.result ? h.result.events.map((e) => ({ seq: h.seq, ...e })) : []));
        print({ id, snapshot: sim.snapshot(), events });
        break;
      }
      case "list": {
        print({ simulations: store.listSims() });
        break;
      }
      default:
        usage();
        process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof SimError) {
      console.error(`错误 [${e.code}]: ${e.message}`);
      process.exitCode = 1;
    } else throw e;
  } finally {
    store.close();
  }
}

main();
