# MESI 缓存一致性事件模拟与状态核验后端

一个本地教学用的 MESI 缓存一致性模拟服务。使用 2 到 4 个核心和少量命名内存地址, 执行读取、写入和显式逐出命令, 展示 MESI 状态变化与总线事件。纯 TypeScript + Node.js + SQLite, 只提供 HTTP API 与 CLI, 无 Docker / WSL / 外部服务依赖。

## 教学语义说明(重要)

这是一个**同步教学模型**, 不是现代处理器的完整实现:

- 不读取真实 CPU 缓存, 不运行用户机器码。
- 不模拟时延、乱序执行、原子指令或真实多线程; 所有命令按提交顺序**逐条原子完成**。
- 每个命名地址视为一条独立缓存行; 缓存无容量限制, 不做替换算法, 逐出只能靠显式 `evict` 命令。
- 内存值在存在 M 副本时允许暂时落后; 报告区分"缓存最新值"与"内存已写回值"。

## MESI 转移规则

- 初始所有核心对该地址为 `I`, 内存保存初值。
- **读命中**(S/E/M): 不发总线请求, 直接返回本地值。
- **读缺失**: 发 `BusRd`。无其他有效副本时请求者得 `E`; 否则得 `S`。其他核心持 `E` 降为 `S`; 持 `M` 先写回内存再降为 `S`, 新读取者得到同一最新值(绝不从落后的内存返回旧值)。
- **写命中 E**: 直接变 `M`; **写命中 M**: 本地修改, 无事件。
- **写命中 S**: 发 `BusUpgr`, 其他副本失效后本侧变 `M`。
- **写缺失**: 发 `BusRdX`, 其他持有者写回并失效, 请求者持 `M` 与新值。
- **逐出 M**: 必须写回(`WriteBack`); 逐出 S/E 只丢弃副本; 只剩一个 S 时**保持 S**, 不自动伪造 E。

不变量检查器核对: 任一时刻至多一个 M/E; M/E 存在时其他副本均为 I; 多份 S 的值彼此一致且与内存一致。失败命令(参数错误等)不会修改模拟状态, 也不会写入历史。

## 快速开始

要求: Node.js >= 22(使用内置 `node:sqlite`, 无需原生编译), Windows 本地直接运行。

```powershell
npm install      # 仅安装 typescript 与 @types/node (开发依赖)
npm run build    # 编译到 dist/
npm test         # 构建并运行全部测试
npm start        # 启动 HTTP 服务 (默认自动选择空闲端口)
npm start -- --port=8080   # 指定端口
npm run demo     # 三核心读写同一地址的完整演示
```

数据保存在项目内 `data/mesi.db`, 重启后自动从保存点继续; 状态由初始值 + 命令历史重放重建, 保证可核对。

## HTTP API

统一错误格式: `{ "ok": false, "error": { "code": "...", "message": "..." } }`。
错误码: `INVALID_CORES` `INVALID_CORE` `UNKNOWN_ADDRESS` `INVALID_ADDRESS` `DUPLICATE_ADDRESS` `INVALID_VALUE` `UNKNOWN_OP` `BAD_REQUEST` `NOT_FOUND`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/sims` | 创建模拟, 体: `{"cores":3,"addresses":{"X":10,"Y":0}}` |
| GET | `/sims` | 列出所有模拟 |
| POST | `/sims/:id/commands` | 执行单条命令 `{"op":"read|write|evict","core":0,"address":"X","value":1}` |
| POST | `/sims/:id/batch` | 批量回放 `{"commands":[...]}` |
| GET | `/sims/:id/state` | 查看全部地址的缓存行与内存 |
| GET | `/sims/:id/check` | 检查 MESI 不变量 |
| GET | `/sims/:id/history` | 查看命令历史(含每条前后状态) |
| GET | `/sims/:id/events` | 按序导出全部总线事件 |
| GET | `/sims/:id/export` | 导出命令、事件与最终状态 |

每条命令结果包含: 读到/写入的值、按实际发生顺序的总线事件(`BusRd`/`BusRdX`/`BusUpgr`/`WriteBack`)、该地址各核心前后状态与内存变化。

## CLI

```powershell
node dist/src/cli.js create --cores 3 --addr X=10 --addr Y=0
node dist/src/cli.js list
node dist/src/cli.js exec --sim 1 read 0 X
node dist/src/cli.js exec --sim 1 write 1 X 42
node dist/src/cli.js exec --sim 1 evict 1 X
node dist/src/cli.js batch --sim 1 --file cmds.json   # cmds.json 为命令数组
node dist/src/cli.js state --sim 1
node dist/src/cli.js check --sim 1
node dist/src/cli.js history --sim 1
node dist/src/cli.js events --sim 1
node dist/src/cli.js export --sim 1
```

## 项目结构

- `src/simulator.ts` — MESI 状态机、总线事件、不变量检查器
- `src/store.ts` — SQLite 持久化(初值 + 命令 + 结果), 重放重建状态
- `src/server.ts` / `src/index.ts` — HTTP API 与启动入口
- `src/cli.ts` — 命令行界面
- `src/demo.ts` — 三核心演示脚本
- `test/` — 单元测试与随机对照测试

## 测试覆盖

首次读为 E、第二核心读使双方 S、共享写令别人失效(BusUpgr)、脏行被别人读取时先写回、脏行逐出写回、同核心连续命中无额外总线事件、不同地址互不串数据、失败命令不改状态、SQLite 重启续跑、批量回放一致性, 以及 500 步短随机操作序列对照独立"逻辑最新值"模型核对每次读取并逐步检查不变量。
