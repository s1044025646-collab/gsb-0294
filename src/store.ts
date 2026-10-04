import { DatabaseSync } from "node:sqlite";
import { Simulator, Op, CommandResult, SimError } from "./simulator.js";

export interface HistoryEntry {
  seq: number;
  command: Op;
  result: CommandResult;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cores INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS addresses (
        sim_id INTEGER NOT NULL REFERENCES sims(id),
        address TEXT NOT NULL,
        init_value INTEGER NOT NULL,
        PRIMARY KEY (sim_id, address)
      );
      CREATE TABLE IF NOT EXISTS commands (
        sim_id INTEGER NOT NULL REFERENCES sims(id),
        seq INTEGER NOT NULL,
        command TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (sim_id, seq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createSim(cores: number, initial: Record<string, number>): number {
    const sim = new Simulator(cores, initial); // 校验参数
    const info = this.db.prepare("INSERT INTO sims (cores) VALUES (?)").run(sim.cores);
    const simId = Number(info.lastInsertRowid);
    const stmt = this.db.prepare("INSERT INTO addresses (sim_id, address, init_value) VALUES (?, ?, ?)");
    for (const [addr, v] of Object.entries(initial)) stmt.run(simId, addr, v);
    return simId;
  }

  private loadRow(simId: number): { cores: number; initial: Record<string, number> } {
    const sim = this.db.prepare("SELECT cores FROM sims WHERE id = ?").get(simId) as { cores: number } | undefined;
    if (!sim) throw new SimError("NOT_FOUND", `模拟不存在: ${simId}`);
    const rows = this.db.prepare("SELECT address, init_value FROM addresses WHERE sim_id = ?").all(simId) as { address: string; init_value: number }[];
    const initial: Record<string, number> = {};
    for (const r of rows) initial[r.address] = r.init_value;
    return { cores: sim.cores, initial };
  }

  /** 从初始状态重放全部命令, 返回重建后的模拟器 (也用于核验持久化数据). */
  loadSim(simId: number): Simulator {
    const { cores, initial } = this.loadRow(simId);
    const sim = new Simulator(cores, initial);
    for (const h of this.history(simId)) sim.execute(h.command);
    return sim;
  }

  execute(simId: number, cmd: Op): CommandResult {
    const sim = this.loadSim(simId);
    const result = sim.execute(cmd); // 失败时抛错, 不落库, 状态不变
    const seq = this.nextSeq(simId);
    this.db.prepare("INSERT INTO commands (sim_id, seq, command, result) VALUES (?, ?, ?, ?)")
      .run(simId, seq, JSON.stringify(cmd), JSON.stringify(result));
    return result;
  }

  executeBatch(simId: number, cmds: Op[]): CommandResult[] {
    return cmds.map((c) => this.execute(simId, c));
  }

  private nextSeq(simId: number): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM commands WHERE sim_id = ?").get(simId) as { seq: number };
    return row.seq;
  }

  history(simId: number): HistoryEntry[] {
    this.loadRow(simId); // 校验存在
    const rows = this.db.prepare("SELECT seq, command, result FROM commands WHERE sim_id = ? ORDER BY seq").all(simId) as { seq: number; command: string; result: string }[];
    return rows.map((r) => ({ seq: r.seq, command: JSON.parse(r.command) as Op, result: JSON.parse(r.result) as CommandResult }));
  }

  listSims(): { id: number; cores: number; created_at: string }[] {
    return this.db.prepare("SELECT id, cores, created_at FROM sims ORDER BY id").all() as { id: number; cores: number; created_at: string }[];
  }
}
