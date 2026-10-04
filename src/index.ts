import { createServer } from "./server.js";
import { Store } from "./store.js";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });
const store = new Store(path.join(dataDir, "mesi.db"));

const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.split("=")[1]) : 0; // 默认 0 = 自动选择空闲端口

const server = createServer(store);
server.listen(port, () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`MESI 模拟服务已启动: http://localhost:${actual}`);
  console.log(`数据目录: ${dataDir}`);
});
