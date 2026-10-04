// MESI 缓存一致性教学模拟核心引擎（纯逻辑，无 IO）。
// 语义：同步、原子、按命令顺序执行；每个地址是独立缓存行；无容量替换。

export type MesiState = "M" | "E" | "S" | "I";

export type BusEventType = "BusRd" | "BusRdX" | "BusUpgr" | "WriteBack";

export interface BusEvent {
  type: BusEventType;
  core: number;        // 发起核心
  address: string;
  value?: number;      // WriteBack 时写回的值
}

export interface LineState {
  state: MesiState;
  value: number | null; // I 状态下为 null
}

export interface CoreDelta {
  core: number;
  before: MesiState;
  after: MesiState;
  valueBefore: number | null;
  valueAfter: number | null;
}

export interface CommandResult {
  ok: true;
  command: Command;
  value?: number;             // read 的读值 / write 的写入值
  events: BusEvent[];         // 按实际发生顺序
  cores: CoreDelta[];         // 该地址各核心前后状态
  memory: { before: number; after: number };
}

export type Command =
  | { op: "read"; core: number; address: string }
  | { op: "write"; core: number; address: string; value: number }
  | { op: "evict"; core: number; address: string };

export class SimError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "SimError";
  }
}

export interface SimConfig {
  cores: number; // 2..4
  addresses: Record<string, number>; // 命名地址 -> 初始值
}

export class MesiSim {
  readonly cores: number;
  readonly addressNames: string[];
  private memory: Map<string, number> = new Map();
  private initialMemory: Map<string, number> = new Map();
  // lines[core][address] = LineState
  private lines: Map<string, LineState>[] = [];

  constructor(config: SimConfig) {
    if (!Number.isInteger(config.cores) || config.cores < 2 || config.cores > 4) {
      throw new SimError("INVALID_CORES", "核心数必须是 2 到 4 的整数");
    }
    const names = Object.keys(config.addresses ?? {});
    if (names.length === 0) {
      throw new SimError("INVALID_ADDRESSES", "至少需要一个命名内存地址");
    }
    for (const n of names) {
      const v = config.addresses[n];
      if (!Number.isInteger(v)) {
        throw new SimError("INVALID_VALUE", `地址 ${n} 的初始值必须是整数`);
      }
    }
    this.cores = config.cores;
    this.addressNames = names;
    for (const n of names) {
      this.memory.set(n, config.addresses[n]);
      this.initialMemory.set(n, config.addresses[n]);
    }
    for (let c = 0; c < this.cores; c++) {
      const m = new Map<string, LineState>();
      for (const n of names) m.set(n, { state: "I", value: null });
      this.lines.push(m);
    }
  }

  private line(core: number, address: string): LineState {
    return this.lines[core].get(address)!;
  }

  private validateCore(core: number): void {
    if (!Number.isInteger(core) || core < 0 || core >= this.cores) {
      throw new SimError("UNKNOWN_CORE", `核心编号 ${core} 不存在（有效范围 0..${this.cores - 1}）`);
    }
  }

  private validateAddress(address: string): void {
    if (typeof address !== "string" || !this.memory.has(address)) {
      throw new SimError("UNKNOWN_ADDRESS", `地址 ${String(address)} 不存在`);
    }
  }

  private validateValue(value: number): void {
    if (!Number.isInteger(value)) {
      throw new SimError("INVALID_VALUE", `值 ${value} 不是合法整数`);
    }
  }

  /** 校验并解析外部命令；非法命令抛 SimError，保证不修改状态。 */
  parseCommand(raw: unknown): Command {
    if (typeof raw !== "object" || raw === null) {
      throw new SimError("UNKNOWN_COMMAND", "命令必须是对象");
    }
    const c = raw as Record<string, unknown>;
    switch (c.op) {
      case "read":
        this.validateCore(c.core as number);
        this.validateAddress(c.address as string);
        return { op: "read", core: c.core as number, address: c.address as string };
      case "write":
        this.validateCore(c.core as number);
        this.validateAddress(c.address as string);
        this.validateValue(c.value as number);
        return { op: "write", core: c.core as number, address: c.address as string, value: c.value as number };
      case "evict":
        this.validateCore(c.core as number);
        this.validateAddress(c.address as string);
        return { op: "evict", core: c.core as number, address: c.address as string };
      default:
        throw new SimError("UNKNOWN_COMMAND", `不支持的命令: ${String(c.op)}`);
    }
  }

  /** 执行一条命令。先完整校验，失败则不修改任何状态。 */
  execute(raw: unknown): CommandResult {
    const cmd = this.parseCommand(raw); // 校验失败在此抛出，状态未变
    const events: BusEvent[] = [];
    const addr = cmd.address;
    const memBefore = this.memory.get(addr)!;
    const before: LineState[] = this.lines.map((_, c) => ({ ...this.line(c, addr) }));
    let resultValue: number | undefined;

    if (cmd.op === "read") {
      resultValue = this.doRead(cmd.core, addr, events);
    } else if (cmd.op === "write") {
      this.doWrite(cmd.core, addr, cmd.value, events);
      resultValue = cmd.value;
    } else {
      this.doEvict(cmd.core, addr, events);
    }

    const cores: CoreDelta[] = [];
    for (let c = 0; c < this.cores; c++) {
      const after = this.line(c, addr);
      cores.push({
        core: c,
        before: before[c].state,
        after: after.state,
        valueBefore: before[c].value,
        valueAfter: after.value,
      });
    }
    const result: CommandResult = {
      ok: true,
      command: cmd,
      events,
      cores,
      memory: { before: memBefore, after: this.memory.get(addr)! },
    };
    if (resultValue !== undefined) result.value = resultValue;

    // 每次命令后自检不变量；引擎自身 bug 时抛错（此时状态已变，属内部错误）。
    const violation = this.checkInvariants();
    if (violation) {
      throw new SimError("INVARIANT_VIOLATION", violation);
    }
    return result;
  }

  private doRead(core: number, addr: string, events: BusEvent[]): number {
    const l = this.line(core, addr);
    if (l.state === "S" || l.state === "E" || l.state === "M") {
      return l.value!; // 命中，无总线事件
    }
    // 读缺失：BusRd
    events.push({ type: "BusRd", core, address: addr });
    let othersValid = false;
    for (let c = 0; c < this.cores; c++) {
      if (c === core) continue;
      const o = this.line(c, addr);
      if (o.state === "M") {
        // 先写回最新值，再降为 S
        this.memory.set(addr, o.value!);
        events.push({ type: "WriteBack", core: c, address: addr, value: o.value! });
        o.state = "S";
        othersValid = true;
      } else if (o.state === "E") {
        o.state = "S";
        othersValid = true;
      } else if (o.state === "S") {
        othersValid = true;
      }
    }
    const value = this.memory.get(addr)!;
    l.value = value;
    l.state = othersValid ? "S" : "E";
    return value;
  }

  private doWrite(core: number, addr: string, value: number, events: BusEvent[]): void {
    const l = this.line(core, addr);
    if (l.state === "M") {
      l.value = value; // 本地命中
      return;
    }
    if (l.state === "E") {
      l.state = "M";
      l.value = value; // 静默升级，无总线事件
      return;
    }
    if (l.state === "S") {
      // 升级失效：令其他副本失效
      events.push({ type: "BusUpgr", core, address: addr });
      for (let c = 0; c < this.cores; c++) {
        if (c === core) continue;
        const o = this.line(c, addr);
        if (o.state !== "I") {
          o.state = "I";
          o.value = null;
        }
      }
      l.state = "M";
      l.value = value;
      return;
    }
    // 写缺失：BusRdX
    events.push({ type: "BusRdX", core, address: addr });
    for (let c = 0; c < this.cores; c++) {
      if (c === core) continue;
      const o = this.line(c, addr);
      if (o.state === "M") {
        this.memory.set(addr, o.value!);
        events.push({ type: "WriteBack", core: c, address: addr, value: o.value! });
      }
      if (o.state !== "I") {
        o.state = "I";
        o.value = null;
      }
    }
    l.state = "M";
    l.value = value;
  }

  private doEvict(core: number, addr: string, events: BusEvent[]): void {
    const l = this.line(core, addr);
    if (l.state === "M") {
      this.memory.set(addr, l.value!);
      events.push({ type: "WriteBack", core, address: addr, value: l.value! });
    }
    // S/E/I 逐出只丢弃副本；仅剩一个 S 时允许其继续保持 S，不伪造 E。
    l.state = "I";
    l.value = null;
  }

  /** 不变量检查，返回违规描述或 null。 */
  checkInvariants(): string | null {
    for (const addr of this.addressNames) {
      const states = this.lines.map((_, c) => this.line(c, addr));
      const memVal = this.memory.get(addr)!;
      const mCount = states.filter((s) => s.state === "M").length;
      const eCount = states.filter((s) => s.state === "E").length;
      if (mCount + eCount > 1) {
        return `地址 ${addr}: 同时存在多个 M/E 副本`;
      }
      if (mCount + eCount === 1) {
        const others = states.filter((s) => s.state === "S");
        if (others.length > 0) {
          return `地址 ${addr}: 存在 M/E 时仍有其他有效副本`;
        }
      }
      const shared = states.filter((s) => s.state === "S");
      for (const s of shared) {
        if (s.value !== memVal) {
          return `地址 ${addr}: S 副本值 ${s.value} 与内存值 ${memVal} 不一致`;
        }
      }
      if (shared.length > 1) {
        const v0 = shared[0].value;
        if (!shared.every((s) => s.value === v0)) {
          return `地址 ${addr}: 多个 S 副本值彼此不一致`;
        }
      }
    }
    return null;
  }

  /** 当前完整状态快照。 */
  snapshot() {
    const caches: Record<string, Record<string, LineState>> = {};
    for (let c = 0; c < this.cores; c++) {
      const per: Record<string, LineState> = {};
      for (const addr of this.addressNames) {
        const l = this.line(c, addr);
        per[addr] = { state: l.state, value: l.value };
      }
      caches[`core${c}`] = per;
    }
    const memory: Record<string, number> = {};
    const initialMemory: Record<string, number> = {};
    for (const addr of this.addressNames) {
      memory[addr] = this.memory.get(addr)!;
      initialMemory[addr] = this.initialMemory.get(addr)!;
    }
    return { cores: this.cores, caches, memory, initialMemory };
  }

  /** 每个地址的逻辑最新值（M 副本优先，否则内存值）。 */
  logicalValues(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const addr of this.addressNames) {
      let v = this.memory.get(addr)!;
      for (let c = 0; c < this.cores; c++) {
        const l = this.line(c, addr);
        if (l.state === "M") v = l.value!;
      }
      out[addr] = v;
    }
    return out;
  }
}
