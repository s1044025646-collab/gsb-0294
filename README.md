# MESI 缓存一致性事件模拟与状态核验后端

一个本地教学用的缓存一致性模拟服务：2~4 个核心、少量命名内存地址，支持读取、写入、显式逐出命令，展示 MESI 状态变化与总线事件。仅提供 HTTP API 与 CLI，无 GUI。

> **教学语义声明**：本项目实现的是**同步、原子、按命令顺序执行**的教学模型。它不读取真实 CPU 缓存、不运行用户机器码，也不模拟时延、乱序执行、原子指令或实际多线程，**不是现代处理器缓存一致性的全部实现细节**。每个地址视为一条独立缓存行，缓存无容量替换算法。

## 环境要求

- Windows 本地运行，Node.js >= 22（使用内置 `node:sqlite`，无需原生编译）
- 不依赖 Docker、WSL、付费服务或外部在线 API

## 快速开始

```powershell
npm install        # 安装 TypeScript 等开发依赖
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务（默认选择空闲端口）
npm run demo       # 三核心读写同一地址的完整演示
npm run cli -- list   # CLI 入口
```

指定端口：`node dist/src/server.js --port 8080`（或环境变量 `PORT`；默认 0 即操作系统分配空闲端口）。
数据库文件默认在项目内 `data/mesi.db`，可用环境变量 `MESI_DB` 覆盖。

## 模型语义

- 初始所有核心为 `I`，内存保存初值。
- **读**：命中 `S/E/M` 不发总线请求；缺失发 `BusRd`。无其他有效副本时请求者得 `E`，否则得 `S`；其他核心持 `E` 降为 `S`，持 `M` 先写回内存（`WriteBack` 事件）再降为 `S`，新读取者得到同一最新值——不会从落后的主存返回旧值，也不会同时存在两个独占状态。
- **写**：命中 `E` 静默升 `M`，命中 `M` 直接本地修改（均无总线事件）；命中 `S` 发 `BusUpgr` 使其他副本失效后升 `M`；缺失发 `BusRdX`，先处理其他持有者的写回并令其失效，再由请求者持 `M` 与新值。
- **逐出**：逐出 `M` 必须写回；逐出 `S/E` 只丢弃副本；只剩一个 `S` 副本时允许其继续保持 `S`，不自动伪造 `E`。
- `M` 存在时内存允许暂时落后；状态输出中 `memory` 是已写回值，`logicalValues` 是逻辑最新值（M 副本优先）。
- 每条命令返回：读/写结果值、按实际发生顺序的总线事件、各核心此地址前后状态与值、内存前后值。
- **不变量检查器**：任一时刻每个地址至多一个 `M/E`；`M/E` 存在时其他副本均为 `I`；多份 `S` 的值彼此一致且与内存一致。每条命令执行后自动自检，也可通过 `check` 接口手动检查并从初始状态完整重放核对。
- **失败命令不修改模拟状态**：所有参数先校验后执行；失败命令连同错误码记入历史。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/simulations` | 创建模拟，body: `{"cores":3,"addresses":{"X":0,"Y":10}}` |
| GET | `/simulations` | 列出所有模拟 |
| GET | `/simulations/:id/state` | 读取缓存、内存与逻辑最新值 |
| POST | `/simulations/:id/commands` | 执行单条命令 `{"op":"read|write|evict","core":0,"address":"X","value":1}` |
| POST | `/simulations/:id/replay` | 批量回放 `{"commands":[...]}`，逐条返回结果或错误 |
| GET | `/simulations/:id/check` | 检查不变量并从初始状态重放核对 |
| GET | `/simulations/:id/history` | 查看命令历史（含失败命令及错误码） |
| GET | `/simulations/:id/export` | 导出最终快照与全部总线事件 |

### 错误码

`INVALID_CORES`（核心数非 2~4）、`INVALID_ADDRESSES`、`UNKNOWN_CORE`、`UNKNOWN_ADDRESS`、`INVALID_VALUE`（非整数）、`UNKNOWN_COMMAND`、`UNKNOWN_SIMULATION`、`BAD_JSON`、`BAD_REQUEST`、`NOT_FOUND`、`INVARIANT_VIOLATION`。错误响应形如 `{"ok":false,"error":{"code":"...","message":"..."}}`。

## CLI

```powershell
node dist/src/cli.js create --cores 3 --addr X=0 --addr Y=10
node dist/src/cli.js exec 1 read 0 X
node dist/src/cli.js exec 1 write 1 X 42
node dist/src/cli.js exec 1 evict 1 X
node dist/src/cli.js replay 1 commands.json   # JSON 数组批量回放
node dist/src/cli.js state 1                  # 缓存与内存
node dist/src/cli.js check 1                  # 不变量 + 重放核对
node dist/src/cli.js history 1                # 命令历史
node dist/src/cli.js export 1                 # 导出事件
node dist/src/cli.js list
```

## 持久化与恢复

SQLite 保存模拟配置（含各地址初值）与全部命令（含失败命令及错误码）。重启后首次访问某个模拟时自动从保存的命令重放恢复当前状态；`check` 会从初始状态完整重放并核对不变量。

## 测试

`npm test` 覆盖：首次读为 E、第二核心读使双方 S、共享写令别人失效、脏行被别人读取时先写回、脏行逐出写回、同核心连续命中无额外总线事件、不同地址互不串数据、非法命令报错且不改状态，以及短随机操作序列对照独立逻辑最新值模型并逐步检查不变量。

## 限制

- 同步教学语义，不模拟并发、时延、乱序、原子指令、缓存容量与替换。
- 每个地址独立成行；地址数量与核心数（2~4）按教学规模设计。
- `node:sqlite` 在部分 Node 版本标记为 experimental，启动时可能有提示警告，不影响功能。
