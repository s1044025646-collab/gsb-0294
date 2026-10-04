// SQLite 持久化：保存模拟配置、命令历史，重启后可恢复或从头重放。
import { DatabaseSync } from "node:sqlite";
import { MesiSim, SimConfig, CommandResult, SimError } from "./mesi";

export interface HistoryEntry {
  seq: number;
  command: unknown;
  result: CommandResult | null; // 失败命令记录 null 并保存错误
  error?: { code: string; message: string };
}

export class SimStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS simulations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cores INTEGER NOT NULL,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        sim_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        command TEXT NOT NULL,
        result TEXT,
        error TEXT,
        PRIMARY KEY (sim_id, seq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createSim(config: SimConfig): number {
    const stmt = this.db.prepare(
      "INSERT INTO simulations (cores, config, created_at) VALUES (?, ?, ?)"
    );
    const r = stmt.run(config.cores, JSON.stringify(config), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getConfig(simId: number): SimConfig {
    const row = this.db
      .prepare("SELECT config FROM simulations WHERE id = ?")
      .get(simId) as { config: string } | undefined;
    if (!row) throw new SimError("UNKNOWN_SIMULATION", `模拟 ${simId} 不存在`);
    return JSON.parse(row.config) as SimConfig;
  }

  listSims(): { id: number; cores: number; created_at: string }[] {
    return this.db
      .prepare("SELECT id, cores, created_at FROM simulations ORDER BY id")
      .all() as { id: number; cores: number; created_at: string }[];
  }

  appendCommand(simId: number, command: unknown, result: CommandResult | null, error?: { code: string; message: string }): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM commands WHERE sim_id = ?")
      .get(simId) as { seq: number };
    this.db
      .prepare("INSERT INTO commands (sim_id, seq, command, result, error) VALUES (?, ?, ?, ?, ?)")
      .run(simId, row.seq, JSON.stringify(command), result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null);
    return row.seq;
  }

  history(simId: number): HistoryEntry[] {
    const rows = this.db
      .prepare("SELECT seq, command, result, error FROM commands WHERE sim_id = ? ORDER BY seq")
      .all(simId) as { seq: number; command: string; result: string | null; error: string | null }[];
    return rows.map((r) => ({
      seq: r.seq,
      command: JSON.parse(r.command),
      result: r.result ? (JSON.parse(r.result) as CommandResult) : null,
      error: r.error ? JSON.parse(r.error) : undefined,
    }));
  }

  /** 从保存点恢复：重放所有成功命令，重建当前状态。 */
  loadSim(simId: number): MesiSim {
    const config = this.getConfig(simId);
    const sim = new MesiSim(config);
    for (const h of this.history(simId)) {
      if (h.result) sim.execute(h.command);
    }
    return sim;
  }

  /** 从初始状态完整重放并核对最终状态是否与保存点一致。 */
  verifyReplay(simId: number): { ok: boolean; detail: string } {
    const sim = this.loadSim(simId);
    const violation = sim.checkInvariants();
    if (violation) return { ok: false, detail: violation };
    return { ok: true, detail: `重放 ${this.history(simId).filter((h) => h.result).length} 条命令后不变量全部成立` };
  }
}
