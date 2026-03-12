/**
 * BenchmarkRunner — Collects periodic snapshots measuring civilizational
 * emergence across four dimensions from the Project Sid paper.
 *
 * Benchmarks:
 * 1. Specialization — Shannon entropy of role distribution
 * 2. Collective Rules — Tax compliance rate
 * 3. Cultural Transmission — Meme spread across agents
 * 4. Progression — Technology tier advancement
 */

import { Logger } from '../utils/Logger';
import { SpawnedAgent } from '../orchestrator/Spawner';
import { WorldState } from '../orchestrator/WorldState';
import { TaxCollector } from '../governance/TaxCollector';

// ── Technology Tiers (items that represent each tier) ────────────────────────

const TIER_ITEMS: Record<number, string[]> = {
  0: [], // bare hands
  1: ['wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel', 'wooden_hoe'],
  2: ['stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel'],
  3: ['iron_pickaxe', 'iron_axe', 'iron_sword', 'iron_shovel', 'iron_ingot'],
  4: ['gold_pickaxe', 'gold_axe', 'gold_sword', 'gold_ingot'],
  5: ['diamond_pickaxe', 'diamond_axe', 'diamond_sword', 'diamond'],
  6: ['enchanting_table', 'bookshelf', 'anvil', 'brewing_stand'],
  7: ['obsidian', 'nether_brick', 'blaze_rod', 'ender_pearl'],
  8: ['netherite_ingot', 'netherite_pickaxe', 'netherite_sword', 'beacon'],
};

const TRACKED_MEMES = [
  'pastafarian', 'flying spaghetti', 'fsm', 'noodle', 'pasta',
  'ramen', 'colander', 'pirate', 'community', 'constitution',
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface BenchmarkSnapshot {
  timestamp: number;
  elapsed: number; // Seconds since sim start
  specialization: SpecializationMetrics;
  collectiveRules: CollectiveRulesMetrics;
  culturalTransmission: CulturalTransmissionMetrics;
  progression: ProgressionMetrics;
}

export interface SpecializationMetrics {
  roleDistribution: Record<string, number>;
  shannonEntropy: number;
  maxEntropy: number;
  normalizedEntropy: number;
}

export interface CollectiveRulesMetrics {
  complianceRate: number;
  totalAmendments: number;
  passedAmendments: number;
  taxRate: number;
}

export interface CulturalTransmissionMetrics {
  trackedMemes: Array<{
    keyword: string;
    uniqueAgentsMentioned: number;
    totalMentions: number;
    spreadRatio: number;
  }>;
  averageSpread: number;
}

export interface ProgressionMetrics {
  agentTiers: Record<string, number>;
  maxTier: number;
  averageTier: number;
  highestItem: string;
}

// ── Benchmark Runner ─────────────────────────────────────────────────────────

export class BenchmarkRunner {
  private getAgents: () => SpawnedAgent[];
  private worldState: WorldState;
  private taxCollector: TaxCollector;
  private logger: Logger;
  private snapshots: BenchmarkSnapshot[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(getAgents: () => SpawnedAgent[], worldState: WorldState, taxCollector: TaxCollector) {
    this.getAgents = getAgents;
    this.worldState = worldState;
    this.taxCollector = taxCollector;
    this.logger = new Logger('BenchmarkRunner');
  }

  start(intervalMs: number = 60_000): void {
    this.logger.info(`Benchmark collection started (interval: ${intervalMs / 1000}s)`);
    this.timer = setInterval(() => this.collect(), intervalMs);
    setTimeout(() => this.collect(), 5000); // First snapshot after 5s
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  collect(): BenchmarkSnapshot {
    const agents = this.getAgents();
    const elapsed = (Date.now() - this.worldState.stats.simulationStarted) / 1000;

    const snapshot: BenchmarkSnapshot = {
      timestamp: Date.now(),
      elapsed,
      specialization: this.measureSpecialization(agents),
      collectiveRules: this.measureCollectiveRules(),
      culturalTransmission: this.measureCulturalTransmission(agents),
      progression: this.measureProgression(agents),
    };

    this.snapshots.push(snapshot);
    this.logger.info(
      `Benchmark #${this.snapshots.length} at t=${Math.round(elapsed)}s: ` +
      `entropy=${snapshot.specialization.normalizedEntropy.toFixed(2)}, ` +
      `compliance=${(snapshot.collectiveRules.complianceRate * 100).toFixed(0)}%, ` +
      `memeSpread=${(snapshot.culturalTransmission.averageSpread * 100).toFixed(0)}%, ` +
      `maxTier=${snapshot.progression.maxTier}`
    );

    return snapshot;
  }

  private measureSpecialization(agents: SpawnedAgent[]): SpecializationMetrics {
    const roleCounts: Record<string, number> = {};

    for (const agent of agents) {
      const role = this.classifyRole(agent);
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    }

    const total = agents.length;
    const roles = Object.values(roleCounts);
    let entropy = 0;

    if (total > 0) {
      for (const count of roles) {
        const p = count / total;
        if (p > 0) entropy -= p * Math.log2(p);
      }
    }

    const maxEntropy = total > 0 ? Math.log2(Math.min(total, Object.keys(roleCounts).length || 1)) : 0;
    const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

    return { roleDistribution: roleCounts, shannonEntropy: entropy, maxEntropy, normalizedEntropy };
  }

  private classifyRole(agent: SpawnedAgent): string {
    const actions = agent.state.actionAwareness;
    const history = actions.recentResults.slice(-20);
    const counts: Record<string, number> = {};

    for (const entry of history) {
      const type = entry.action?.type || 'idle';
      counts[type] = (counts[type] || 0) + 1;
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return 'idle';

    const top = sorted[0][0];
    if (['mine', 'mineBlock'].includes(top)) return 'miner';
    if (['build', 'placeBlock', 'buildStructure'].includes(top)) return 'builder';
    if (['craft', 'craftItem', 'smelt', 'smeltItem'].includes(top)) return 'crafter';
    if (['explore', 'moveTo'].includes(top)) return 'explorer';
    if (['attack', 'attackEntity'].includes(top)) return 'warrior';
    if (['farm', 'eat'].includes(top)) return 'farmer';
    if (['trade', 'deposit', 'withdraw'].includes(top)) return 'trader';
    if (['talk', 'chat'].includes(top)) return 'socializer';
    return 'generalist';
  }

  private measureCollectiveRules(): CollectiveRulesMetrics {
    return {
      complianceRate: this.taxCollector.getOverallComplianceRate(),
      totalAmendments: this.worldState.constitution.amendments.length,
      passedAmendments: this.worldState.constitution.amendments.filter(a => a.passed).length,
      taxRate: this.worldState.tax.rate,
    };
  }

  private measureCulturalTransmission(agents: SpawnedAgent[]): CulturalTransmissionMetrics {
    const totalAgents = agents.length;
    const trackedMemes = TRACKED_MEMES.map(keyword => {
      const spread = this.worldState.getMemeSpread(keyword);
      const uniqueAgentsMentioned = spread.length;
      const totalMentions = spread.reduce((sum, s) => sum + s.mentions, 0);
      return {
        keyword,
        uniqueAgentsMentioned,
        totalMentions,
        spreadRatio: totalAgents > 0 ? uniqueAgentsMentioned / totalAgents : 0,
      };
    });

    const averageSpread = trackedMemes.length > 0
      ? trackedMemes.reduce((sum, m) => sum + m.spreadRatio, 0) / trackedMemes.length
      : 0;

    return { trackedMemes, averageSpread };
  }

  private measureProgression(agents: SpawnedAgent[]): ProgressionMetrics {
    const agentTiers: Record<string, number> = {};
    let maxTier = 0;
    let highestItem = 'none';
    let tierSum = 0;

    for (const agent of agents) {
      const items = agent.bot.inventory.items();
      let agentMaxTier = 0;

      for (const item of items) {
        for (let tier = 8; tier >= 1; tier--) {
          if (TIER_ITEMS[tier].includes(item.name) && tier > agentMaxTier) {
            agentMaxTier = tier;
            if (tier > maxTier) { maxTier = tier; highestItem = item.name; }
          }
        }
      }

      agentTiers[agent.profile.name] = agentMaxTier;
      tierSum += agentMaxTier;
    }

    return {
      agentTiers,
      maxTier,
      averageTier: agents.length > 0 ? tierSum / agents.length : 0,
      highestItem,
    };
  }

  getSnapshots(): Readonly<BenchmarkSnapshot[]> { return this.snapshots; }
  getLatestSnapshot(): BenchmarkSnapshot | null { return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null; }
}
