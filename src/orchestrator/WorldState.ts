/**
 * WorldState — Shared world-level state: constitution, tax chests,
 * elections, cultural memes, and aggregate statistics.
 */

import { Logger } from '../utils/Logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Constitution {
  preamble: string;
  articles: ConstitutionArticle[];
  amendments: Amendment[];
  ratifiedAt: number;
}

export interface ConstitutionArticle {
  id: number;
  title: string;
  text: string;
}

export interface Amendment {
  id: number;
  description: string;
  proposedBy: string;
  votesFor: string[];
  votesAgainst: string[];
  passed: boolean;
  timestamp: number;
}

export interface TaxConfig {
  rate: number;
  chestLocations: Array<{ x: number; y: number; z: number }>;
  depositLog: TaxDeposit[];
}

export interface TaxDeposit {
  agentName: string;
  itemName: string;
  count: number;
  timestamp: number;
}

export interface CulturalMeme {
  id: string;
  keyword: string;
  description: string;
  originAgent: string;
  firstMentioned: number;
  mentions: Map<string, number>;
}

export interface WorldStats {
  simulationStarted: number;
  totalChatMessages: number;
  totalActionsPerformed: number;
  totalLLMCalls: number;
  agentsAlive: number;
  tickCount: number;
}

// ── World State ──────────────────────────────────────────────────────────────

export class WorldState {
  public constitution: Constitution;
  public tax: TaxConfig;
  public memes: Map<string, CulturalMeme> = new Map();
  public stats: WorldStats;
  private logger: Logger;

  constructor() {
    this.logger = new Logger('WorldState');
    this.constitution = {
      preamble: 'We, the agents of this community, establish this constitution to govern our shared society.',
      articles: [
        { id: 1, title: 'Community Purpose', text: 'All agents shall work together toward the community goal of mutual prosperity and growth.' },
        { id: 2, title: 'Resource Sharing', text: 'Agents shall contribute a fair share of gathered resources to the community chest.' },
        { id: 3, title: 'Respect', text: 'All agents shall treat each other with respect and resolve disputes through dialogue.' },
        { id: 4, title: 'Taxation', text: 'Each agent shall deposit 10% of gathered resources into the community chest.' },
        { id: 5, title: 'Governance', text: 'Laws may be amended by majority vote of all active agents.' },
      ],
      amendments: [],
      ratifiedAt: Date.now(),
    };
    this.tax = { rate: 0.1, chestLocations: [], depositLog: [] };
    this.stats = { simulationStarted: Date.now(), totalChatMessages: 0, totalActionsPerformed: 0, totalLLMCalls: 0, agentsAlive: 0, tickCount: 0 };
  }

  getConstitutionText(): string {
    let text = this.constitution.preamble + '\n\n';
    for (const article of this.constitution.articles) {
      text += `Article ${article.id}: ${article.title}\n${article.text}\n\n`;
    }
    if (this.constitution.amendments.length > 0) {
      text += 'Amendments:\n';
      for (const a of this.constitution.amendments.filter(am => am.passed)) {
        text += `Amendment ${a.id}: ${a.description}\n`;
      }
    }
    return text;
  }

  proposeAmendment(description: string, proposedBy: string): Amendment {
    const amendment: Amendment = {
      id: this.constitution.amendments.length + 1, description, proposedBy,
      votesFor: [], votesAgainst: [], passed: false, timestamp: Date.now(),
    };
    this.constitution.amendments.push(amendment);
    this.logger.info(`Amendment ${amendment.id} proposed by ${proposedBy}: ${description}`);
    return amendment;
  }

  vote(amendmentId: number, agentName: string, inFavor: boolean): boolean {
    const amendment = this.constitution.amendments.find(a => a.id === amendmentId);
    if (!amendment) return false;
    amendment.votesFor = amendment.votesFor.filter(n => n !== agentName);
    amendment.votesAgainst = amendment.votesAgainst.filter(n => n !== agentName);
    if (inFavor) { amendment.votesFor.push(agentName); } else { amendment.votesAgainst.push(agentName); }
    return true;
  }

  resolveAmendment(amendmentId: number, totalAgents: number): boolean {
    const amendment = this.constitution.amendments.find(a => a.id === amendmentId);
    if (!amendment) return false;
    // Guard: skip amendments with no description (e.g. LLM returned an empty object)
    if (!amendment.description) {
      this.logger.warn(`Amendment ${amendmentId} has no description — skipping resolve`);
      return false;
    }
    const totalVotes = amendment.votesFor.length + amendment.votesAgainst.length;
    if (totalVotes < Math.ceil(totalAgents / 2)) return false;
    amendment.passed = amendment.votesFor.length > amendment.votesAgainst.length;
    if (amendment.passed) {
      this.logger.info(`Amendment ${amendmentId} PASSED: ${amendment.description}`);
      const taxMatch = amendment.description.match(/tax.*?(\d+)%/i);
      if (taxMatch) { this.tax.rate = parseInt(taxMatch[1]) / 100; }
    } else {
      this.logger.info(`Amendment ${amendmentId} FAILED`);
    }
    return amendment.passed;
  }

  recordDeposit(agentName: string, itemName: string, count: number): void {
    this.tax.depositLog.push({ agentName, itemName, count, timestamp: Date.now() });
  }

  getTaxCompliance(agentName: string): number {
    return this.tax.depositLog.filter(d => d.agentName === agentName).reduce((sum, d) => sum + d.count, 0);
  }

  trackMeme(keyword: string, agentName: string, description?: string): void {
    const id = keyword.toLowerCase();
    let meme = this.memes.get(id);
    if (!meme) {
      meme = { id, keyword, description: description || keyword, originAgent: agentName, firstMentioned: Date.now(), mentions: new Map() };
      this.memes.set(id, meme);
      this.logger.info(`New meme detected: "${keyword}" from ${agentName}`);
    }
    const current = meme.mentions.get(agentName) || 0;
    meme.mentions.set(agentName, current + 1);
  }

  getMemeSpread(keyword: string): { agentName: string; mentions: number }[] {
    const meme = this.memes.get(keyword.toLowerCase());
    if (!meme) return [];
    return Array.from(meme.mentions.entries()).map(([agentName, mentions]) => ({ agentName, mentions })).sort((a, b) => b.mentions - a.mentions);
  }

  toJSON(): object {
    return {
      constitution: this.constitution,
      tax: this.tax,
      memes: Array.from(this.memes.entries()).map(([id, meme]) => ({
        ...meme, mentions: Object.fromEntries(meme.mentions),
      })),
      stats: this.stats,
    };
  }
}
