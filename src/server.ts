// HTTP API 服务器（node:http，无外部依赖）。
import http from "node:http";
import path from "node:path";
import { SimStore } from "./store";
import { MesiSim, SimError, SimConfig } from "./mesi";

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.MESI_DB ?? path.join(DATA_DIR, "mesi.db");

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new SimError("BAD_REQUEST", "请求体过大"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new SimError("BAD_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: SimStore): http.Server {
  // 内存中缓存活跃模拟；未命中时从 SQLite 重放恢复。
  const sims = new Map<number, MesiSim>();
  const getSim = (id: number): MesiSim => {
    let s = sims.get(id);
    if (!s) {
      s = store.loadSim(id);
      sims.set(id, s);
    }
    return s;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/") {
        return send(res, 200, {
          name: "mesi-sim",
          endpoints: [
            "POST /simulations {cores, addresses:{name:init}}",
            "GET /simulations",
            "GET /simulations/:id/state",
            "POST /simulations/:id/commands {op,core,address,value?}",
            "POST /simulations/:id/replay {commands:[...]}",
            "GET /simulations/:id/check",
            "GET /simulations/:id/history",
            "GET /simulations/:id/export",
          ],
        });
      }

      if (method === "POST" && url.pathname === "/simulations") {
        const body = (await readBody(req)) as SimConfig;
        const config: SimConfig = { cores: body.cores, addresses: body.addresses };
        new MesiSim(config); // 先校验配置
        const id = store.createSim(config);
        return send(res, 201, { id, config });
      }

      if (method === "GET" && url.pathname === "/simulations") {
        return send(res, 200, { simulations: store.listSims() });
      }

      if (parts[0] === "simulations" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new SimError("BAD_REQUEST", "模拟 id 必须是整数");
        const sub = parts[2];

        if (method === "GET" && sub === "state") {
          const sim = getSim(id);
          return send(res, 200, { id, ...sim.snapshot(), logicalValues: sim.logicalValues() });
        }
        if (method === "POST" && sub === "commands") {
          const body = await readBody(req);
          const sim = getSim(id);
          try {
            const result = sim.execute(body);
            store.appendCommand(id, body, result);
            return send(res, 200, result);
          } catch (e) {
            if (e instanceof SimError) {
              store.appendCommand(id, body, null, { code: e.code, message: e.message });
              return send(res, 400, { ok: false, error: { code: e.code, message: e.message } });
            }
            throw e;
          }
        }
        if (method === "POST" && sub === "replay") {
          const body = (await readBody(req)) as { commands?: unknown[] };
          if (!Array.isArray(body.commands)) {
            throw new SimError("BAD_REQUEST", "replay 需要 {commands: [...]}");
          }
          const sim = getSim(id);
          const results: unknown[] = [];
          for (const cmd of body.commands) {
            try {
              const r = sim.execute(cmd);
              store.appendCommand(id, cmd, r);
              results.push(r);
            } catch (e) {
              if (e instanceof SimError) {
                store.appendCommand(id, cmd, null, { code: e.code, message: e.message });
                results.push({ ok: false, error: { code: e.code, message: e.message } });
              } else throw e;
            }
          }
          return send(res, 200, { ok: true, results });
        }
        if (method === "GET" && sub === "check") {
          const sim = getSim(id);
          const violation = sim.checkInvariants();
          const replay = store.verifyReplay(id);
          return send(res, 200, {
            ok: violation === null && replay.ok,
            invariant: violation ?? "ok",
            replay: replay.detail,
          });
        }
        if (method === "GET" && sub === "history") {
          store.getConfig(id); // 校验存在
          return send(res, 200, { id, history: store.history(id) });
        }
        if (method === "GET" && sub === "export") {
          const sim = getSim(id);
          const events = store
            .history(id)
            .flatMap((h) => (h.result ? h.result.events.map((e) => ({ seq: h.seq, ...e })) : []));
          return send(res, 200, { id, snapshot: sim.snapshot(), events });
        }
      }

      throw new SimError("NOT_FOUND", `未匹配的路由: ${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof SimError) {
        const status = e.code === "NOT_FOUND" || e.code === "UNKNOWN_SIMULATION" ? 404 : 400;
        return send(res, status, { ok: false, error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

export function startServer(port: number): Promise<number> {
  const store = new SimStore(DB_PATH);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`MESI 模拟服务已启动: http://localhost:${actual} (数据库: ${DB_PATH})`);
      resolve(actual);
    });
  });
}

if (require.main === module) {
  const idx = process.argv.indexOf("--port");
  const port = idx >= 0 ? Number(process.argv[idx + 1]) : Number(process.env.PORT ?? 0); // 默认空闲端口
  void startServer(port);
}
