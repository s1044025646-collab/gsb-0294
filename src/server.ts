import http from "node:http";
import { Store } from "./store.js";
import { SimError } from "./simulator.js";
import { parseCommand } from "./validate.js";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new SimError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }
      if (method === "GET" && url.pathname === "/sims") {
        return send(res, 200, { sims: store.listSims() });
      }
      if (method === "POST" && url.pathname === "/sims") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const cores = body.cores;
        const addresses = body.addresses;
        if (!Number.isInteger(cores)) throw new SimError("INVALID_CORES", "cores 必须是 2..4 的整数");
        if (typeof addresses !== "object" || addresses === null || Array.isArray(addresses)) {
          throw new SimError("BAD_REQUEST", "addresses 必须是 { 地址: 初值 } 对象");
        }
        const id = store.createSim(cores as number, addresses as Record<string, number>);
        return send(res, 201, { id, state: store.loadSim(id).fullState() });
      }

      const m = parts[0] === "sims" ? parts : null;
      if (!m || m.length < 2) throw new SimError("NOT_FOUND", `未知路径: ${url.pathname}`);
      const simId = Number(m[1]);
      if (!Number.isInteger(simId)) throw new SimError("BAD_REQUEST", "模拟 id 必须是整数");
      const sub = m[2];

      if (method === "POST" && sub === "commands") {
        const cmd = parseCommand(await readBody(req));
        return send(res, 200, store.execute(simId, cmd));
      }
      if (method === "POST" && sub === "batch") {
        const body = (await readBody(req)) as Record<string, unknown>;
        if (!Array.isArray(body.commands)) throw new SimError("BAD_REQUEST", "commands 必须是数组");
        const cmds = body.commands.map(parseCommand);
        return send(res, 200, { results: store.executeBatch(simId, cmds) });
      }
      if (method === "GET" && sub === "state") {
        return send(res, 200, { state: store.loadSim(simId).fullState() });
      }
      if (method === "GET" && sub === "check") {
        const violations = store.loadSim(simId).checkInvariants();
        return send(res, 200, { ok: violations.length === 0, violations });
      }
      if (method === "GET" && sub === "history") {
        return send(res, 200, { history: store.history(simId) });
      }
      if (method === "GET" && sub === "events") {
        const events = store.history(simId).flatMap((h) =>
          h.result.events.map((e) => ({ seq: h.seq, ...e }))
        );
        return send(res, 200, { events });
      }
      if (method === "GET" && sub === "export") {
        const history = store.history(simId);
        return send(res, 200, {
          simId,
          state: store.loadSim(simId).fullState(),
          commands: history.map((h) => h.command),
          events: history.flatMap((h) => h.result.events.map((e) => ({ seq: h.seq, ...e }))),
        });
      }
      throw new SimError("NOT_FOUND", `未知路径: ${url.pathname}`);
    } catch (err) {
      if (err instanceof SimError) {
        const status = err.code === "NOT_FOUND" ? 404 : 400;
        return send(res, status, { ok: false, error: { code: err.code, message: err.message } });
      }
      return send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(err) } });
    }
  });
}
