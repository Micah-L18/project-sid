/**
 * SimulationStore — Persists each simulation run to disk.
 *
 * Each run is saved as a JSON file under runs/{id}.json.
 * Runs can be listed and retrieved by the Dashboard.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { BenchmarkSnapshot } from '../benchmarks/BenchmarkRunner';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RunMeta {
  id: string;
  startedAt: string;
  endedAt: string | null;
  agentNames: string[];
  durationMs: number | null;
  finalBenchmark: BenchmarkSnapshot | null;
}

export interface RunRecord extends RunMeta {
  config: object;
  benchmarkHistory: BenchmarkSnapshot[];
  world: object;
  agents: object[];
  chatLog: object[];
  llmStats: object;
}

// ── Store ────────────────────────────────────────────────────────────────────

export class SimulationStore {
  private runsDir: string;
  private logger: Logger;

  constructor(runsDir?: string) {
    this.runsDir = runsDir ?? path.resolve(process.cwd(), 'runs');
    this.logger = new Logger('SimulationStore');
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.logger.info(`Run storage directory: ${this.runsDir}`);
  }

  /** Generate a URL-safe run ID from the current timestamp */
  static generateId(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  /** Save (or overwrite) a complete run record to disk */
  save(record: RunRecord): void {
    const filePath = path.join(this.runsDir, `${record.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    this.logger.info(`Run saved: ${record.id}`);
  }

  /** List all stored runs (metadata only, sorted newest-first) */
  list(): RunMeta[] {
    try {
      const files = fs.readdirSync(this.runsDir).filter(f => f.endsWith('.json'));
      const metas: RunMeta[] = [];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.runsDir, file), 'utf-8');
          const record: RunRecord = JSON.parse(raw);
          metas.push({
            id: record.id,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            agentNames: record.agentNames,
            durationMs: record.durationMs,
            finalBenchmark: record.finalBenchmark,
          });
        } catch { /* skip corrupt files */ }
      }
      return metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    } catch {
      return [];
    }
  }

  /** Get the full record for a run */
  get(id: string): RunRecord | null {
    const filePath = path.join(this.runsDir, `${id}.json`);
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RunRecord;
    } catch {
      return null;
    }
  }
}
