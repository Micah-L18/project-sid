/**
 * TaxCollector — Monitors agent inventories and community chest deposits.
 *
 * Since bots can't easily monitor external chest contents in Mineflayer,
 * the TaxCollector works by comparing agent inventory snapshots and
 * tracking deposited items via the WorldState deposit log.
 */

import { Logger } from '../utils/Logger';
import { WorldState } from '../orchestrator/WorldState';
import { SpawnedAgent } from '../orchestrator/Spawner';

export interface ComplianceReport {
  agentName: string;
  totalGathered: number;
  totalDeposited: number;
  expectedDeposit: number;
  compliant: boolean;
  complianceRatio: number;
}

export class TaxCollector {
  private worldState: WorldState;
  private getAgents: () => SpawnedAgent[];
  private logger: Logger;
  private inventorySnapshots: Map<string, Map<string, number>> = new Map();
  private gatherTotals: Map<string, number> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(worldState: WorldState, getAgents: () => SpawnedAgent[]) {
    this.worldState = worldState;
    this.getAgents = getAgents;
    this.logger = new Logger('TaxCollector');
  }

  start(intervalMs: number = 30_000): void {
    this.logger.info(`Tax collection monitoring started (interval: ${intervalMs / 1000}s)`);
    this.timer = setInterval(() => this.checkInventories(), intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private checkInventories(): void {
    for (const agent of this.getAgents()) {
      const name = agent.profile.name;
      const items = agent.bot.inventory.items();
      const currentInventory = new Map<string, number>();

      for (const item of items) {
        const current = currentInventory.get(item.name) || 0;
        currentInventory.set(item.name, current + item.count);
      }

      const oldInventory = this.inventorySnapshots.get(name);
      if (oldInventory) {
        // Detect gains
        for (const [itemName, count] of currentInventory) {
          const oldCount = oldInventory.get(itemName) || 0;
          if (count > oldCount) {
            const gained = count - oldCount;
            const totalGathered = (this.gatherTotals.get(name) || 0) + gained;
            this.gatherTotals.set(name, totalGathered);
          }
        }
      }

      this.inventorySnapshots.set(name, currentInventory);
    }
  }

  getComplianceReport(): ComplianceReport[] {
    const reports: ComplianceReport[] = [];
    const taxRate = this.worldState.tax.rate;

    for (const agent of this.getAgents()) {
      const name = agent.profile.name;
      const totalGathered = this.gatherTotals.get(name) || 0;
      const totalDeposited = this.worldState.getTaxCompliance(name);
      const expectedDeposit = Math.floor(totalGathered * taxRate);
      const complianceRatio = expectedDeposit === 0 ? 1 : Math.min(1, totalDeposited / expectedDeposit);
      const compliant = complianceRatio >= 0.8;

      reports.push({ agentName: name, totalGathered, totalDeposited, expectedDeposit, compliant, complianceRatio });
    }

    return reports;
  }

  getOverallComplianceRate(): number {
    const reports = this.getComplianceReport();
    if (reports.length === 0) return 1;
    return reports.filter(r => r.compliant).length / reports.length;
  }
}
