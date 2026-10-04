export type MesiState = "M" | "E" | "S" | "I";

export type BusEventType = "BusRd" | "BusRdX" | "BusUpgr" | "WriteBack";

export interface BusEvent {
  type: BusEventType;
  core: number;
  address: string;
  value?: number;
  note?: string;
}

export interface AddressSnapshot {
  memory: number;
  lines: Record<number, MesiState>;
  values: Record<number, number | null>;
}

export interface CommandResult {
  ok: boolean;
  op: string;
  core: number;
  address: string;
  value?: number;
  events: BusEvent[];
  before: AddressSnapshot;
  after: AddressSnapshot;
  memoryChanged: boolean;
}

export type Op =
  | { op: "read"; core: number; address: string }
  | { op: "write"; core: number; address: string; value: number }
  | { op: "evict"; core: number; address: string };

export class SimError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "SimError";
  }
}

interface Line {
  state: MesiState;
  value: number;
}

interface AddrEntry {
  memory: number;
  lines: Line[];
}

export interface InvariantViolation {
  address: string;
  message: string;
}

export class Simulator {
  readonly cores: number;
  private addrs = new Map<string, AddrEntry>();

  constructor(cores: number, initial: Record<string, number>) {
    if (!Number.isInteger(cores) || cores < 2 || cores > 4) {
      throw new SimError("INVALID_CORES", "核心数必须是 2 到 4 的整数");
    }
    this.cores = cores;
    for (const [addr, v] of Object.entries(initial)) {
      this.addAddress(addr, v);
    }
  }

  private addAddress(address: string, value: number): void {
    if (typeof address !== "string" || address.length === 0) {
      throw new SimError("INVALID_ADDRESS", "地址必须是非空字符串");
    }
    if (this.addrs.has(address)) {
      throw new SimError("DUPLICATE_ADDRESS", `地址已存在: ${address}`);
    }
    if (!Number.isInteger(value)) {
      throw new SimError("INVALID_VALUE", `初值必须是整数: ${address}`);
    }
    this.addrs.set(address, {
      memory: value,
      lines: Array.from({ length: this.cores }, () => ({ state: "I", value: 0 })),
    });
  }

  private entry(address: string): AddrEntry {
    const e = this.addrs.get(address);
    if (!e) throw new SimError("UNKNOWN_ADDRESS", `地址不存在: ${address}`);
    return e;
  }

  private checkCore(core: number): void {
    if (!Number.isInteger(core) || core < 0 || core >= this.cores) {
      throw new SimError("INVALID_CORE", `核心编号必须是 0..${this.cores - 1} 的整数, 收到: ${core}`);
    }
  }

  snapshot(address: string): AddressSnapshot {
    const e = this.entry(address);
    const lines: Record<number, MesiState> = {};
    const values: Record<number, number | null> = {};
    e.lines.forEach((l, i) => {
      lines[i] = l.state;
      values[i] = l.state === "I" ? null : l.value;
    });
    return { memory: e.memory, lines, values };
  }

  fullState(): Record<string, AddressSnapshot> {
    const out: Record<string, AddressSnapshot> = {};
    for (const addr of this.addrs.keys()) out[addr] = this.snapshot(addr);
    return out;
  }

  initialValues(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [addr, e] of this.addrs) out[addr] = e.memory;
    return out;
  }

  execute(cmd: Op): CommandResult {
    const before = this.snapshot(cmd.address);
    const events: BusEvent[] = [];
    let value: number | undefined;
    switch (cmd.op) {
      case "read":
        value = this.doRead(cmd.core, cmd.address, events);
        break;
      case "write":
        this.doWrite(cmd.core, cmd.address, cmd.value, events);
        value = cmd.value;
        break;
      case "evict":
        this.doEvict(cmd.core, cmd.address, events);
        break;
      default:
        throw new SimError("UNKNOWN_OP", `不支持的命令: ${(cmd as Op).op}`);
    }
    const after = this.snapshot(cmd.address);
    return {
      ok: true,
      op: cmd.op,
      core: cmd.core,
      address: cmd.address,
      value,
      events,
      before,
      after,
      memoryChanged: before.memory !== after.memory,
    };
  }

  private doRead(core: number, address: string, events: BusEvent[]): number {
    this.checkCore(core);
    const e = this.entry(address);
    const line = e.lines[core];
    if (line.state !== "I") return line.value; // S/E/M 命中, 无总线事件

    events.push({ type: "BusRd", core, address });
    let shared = false;
    for (let i = 0; i < this.cores; i++) {
      if (i === core) continue;
      const l = e.lines[i];
      if (l.state === "M") {
        e.memory = l.value; // 先写回, 保证读到最新值
        events.push({ type: "WriteBack", core: i, address, value: l.value, note: "M 被 BusRd 监听, 写回内存" });
        l.state = "S";
        shared = true;
      } else if (l.state === "E") {
        l.state = "S";
        shared = true;
      } else if (l.state === "S") {
        shared = true;
      }
    }
    line.value = e.memory;
    line.state = shared ? "S" : "E";
    return line.value;
  }

  private doWrite(core: number, address: string, value: number, events: BusEvent[]): void {
    this.checkCore(core);
    if (!Number.isInteger(value)) {
      throw new SimError("INVALID_VALUE", `写入值必须是整数, 收到: ${value}`);
    }
    const e = this.entry(address);
    const line = e.lines[core];
    if (line.state === "M" || line.state === "E") {
      line.state = "M";
      line.value = value;
      return;
    }
    if (line.state === "S") {
      events.push({ type: "BusUpgr", core, address });
      for (let i = 0; i < this.cores; i++) {
        if (i !== core) e.lines[i].state = "I";
      }
      line.state = "M";
      line.value = value;
      return;
    }
    // I: BusRdX
    events.push({ type: "BusRdX", core, address });
    for (let i = 0; i < this.cores; i++) {
      if (i === core) continue;
      const l = e.lines[i];
      if (l.state === "M") {
        e.memory = l.value;
        events.push({ type: "WriteBack", core: i, address, value: l.value, note: "M 被 BusRdX 监听, 写回内存后失效" });
      }
      l.state = "I";
    }
    line.state = "M";
    line.value = value;
  }

  private doEvict(core: number, address: string, events: BusEvent[]): void {
    this.checkCore(core);
    const e = this.entry(address);
    const line = e.lines[core];
    if (line.state === "I") return; // 已是 I, 无操作
    if (line.state === "M") {
      e.memory = line.value;
      events.push({ type: "WriteBack", core, address, value: line.value, note: "逐出 M, 写回内存" });
    }
    line.state = "I";
    // 注意: 不自动把剩余 S 提升为 E
  }

  checkInvariants(): InvariantViolation[] {
    const violations: InvariantViolation[] = [];
    for (const [addr, e] of this.addrs) {
      const excl: number[] = [];
      const sharedVals: number[] = [];
      for (let i = 0; i < this.cores; i++) {
        const l = e.lines[i];
        if (l.state === "M" || l.state === "E") excl.push(i);
        if (l.state === "S") sharedVals.push(l.value);
      }
      if (excl.length > 1) {
        violations.push({ address: addr, message: `存在多个 M/E 副本: 核心 ${excl.join(",")}` });
      }
      if (excl.length === 1) {
        for (let i = 0; i < this.cores; i++) {
          if (i !== excl[0] && e.lines[i].state !== "I") {
            violations.push({ address: addr, message: `核心 ${excl[0]} 持有独占态, 但核心 ${i} 为 ${e.lines[i].state}` });
          }
        }
      }
      if (sharedVals.length > 0) {
        if (!sharedVals.every((v) => v === sharedVals[0])) {
          violations.push({ address: addr, message: `多个 S 副本值不一致: ${sharedVals.join(",")}` });
        }
        if (sharedVals[0] !== e.memory) {
          violations.push({ address: addr, message: `S 副本值 ${sharedVals[0]} 与内存 ${e.memory} 不一致` });
        }
      }
    }
    return violations;
  }
}
