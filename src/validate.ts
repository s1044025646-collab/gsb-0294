import { Op, SimError } from "./simulator.js";

export function parseCommand(raw: unknown): Op {
  if (typeof raw !== "object" || raw === null) {
    throw new SimError("BAD_REQUEST", "命令必须是对象");
  }
  const r = raw as Record<string, unknown>;
  const { op, core, address, value } = r;
  if (op !== "read" && op !== "write" && op !== "evict") {
    throw new SimError("UNKNOWN_OP", `不支持的命令: ${String(op)} (支持 read/write/evict)`);
  }
  if (!Number.isInteger(core)) {
    throw new SimError("INVALID_CORE", `core 必须是整数, 收到: ${String(core)}`);
  }
  if (typeof address !== "string" || address.length === 0) {
    throw new SimError("INVALID_ADDRESS", "address 必须是非空字符串");
  }
  if (op === "write") {
    if (!Number.isInteger(value)) {
      throw new SimError("INVALID_VALUE", `write 需要整数 value, 收到: ${String(value)}`);
    }
    return { op, core: core as number, address, value: value as number };
  }
  return { op, core: core as number, address };
}
