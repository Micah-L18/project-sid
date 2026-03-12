/**
 * ElectionManager — Runs periodic democratic elections where agents
 * provide feedback on the current constitution and propose amendments.
 *
 * Election flow:
 * 1. Collect feedback from each agent via LLM
 * 2. Aggregate feedback and generate amendment proposals via LLM
 * 3. Each agent votes on amendments via LLM
 * 4. Resolve votes and update the constitution
 */

import { LLMClient } from '../llm/LLMClient';
import { WorldState } from '../orchestrator/WorldState';
import { SpawnedAgent } from '../orchestrator/Spawner';
import { Logger } from '../utils/Logger';

const ELECTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const VOTING_DURATION_MS = 60 * 1000;        // 1 minute

export class ElectionManager {
  private llm: LLMClient;
  private worldState: WorldState;
  private getAgents: () => SpawnedAgent[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private logger: Logger;
  private electionCount: number = 0;

  constructor(llm: LLMClient, worldState: WorldState, getAgents: () => SpawnedAgent[]) {
    this.llm = llm;
    this.worldState = worldState;
    this.getAgents = getAgents;
    this.logger = new Logger('ElectionManager');
  }

  start(): void {
    this.logger.info(`Elections scheduled every ${ELECTION_INTERVAL_MS / 1000}s`);
    this.timer = setInterval(() => this.runElection(), ELECTION_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async runElection(): Promise<void> {
    this.electionCount++;
    const agents = this.getAgents();
    if (agents.length === 0) return;

    this.logger.info(`=== Election ${this.electionCount} starting ===`);

    // Step 1: Collect feedback
    const feedbacks: { name: string; feedback: string }[] = [];
    const constitutionText = this.worldState.getConstitutionText();

    const feedbackPromises = agents.map(async (agent) => {
      try {
        const response = await this.llm.prompt(
          `You are ${agent.profile.name}, with traits: ${agent.profile.traits.join(', ')}.`,
          `Current constitution:
${constitutionText}

What is your feedback on the current constitution? Do you propose any amendments?
Respond in 2-3 sentences.`
        );
        return { name: agent.profile.name, feedback: response };
      } catch {
        return { name: agent.profile.name, feedback: 'No feedback.' };
      }
    });

    feedbacks.push(...await Promise.all(feedbackPromises));
    this.logger.info(`Collected feedback from ${feedbacks.length} agents`);

    // Step 2: Generate amendment proposals
    const feedbackSummary = feedbacks.map(f => `${f.name}: ${f.feedback}`).join('\n');
    let amendments: { description: string }[] = [];

    try {
      const raw = await this.llm.promptJSON<{ amendments: { description: string }[] }>(
        'You are a governance assistant. Propose constitutional amendments based on agent feedback.',
        `Based on the following agent feedback, propose 0-2 constitutional amendments.
Each amendment should be a concise rule change.

Feedback:
${feedbackSummary}

Current constitution:
${constitutionText}

Respond as JSON: { "amendments": [{ "description": "..." }] }`
      );
      amendments = (raw?.amendments ?? []).filter(
        (a): a is { description: string } =>
          typeof a?.description === 'string' && a.description.trim().length > 0
      );
    } catch {
      this.logger.warn('Failed to generate amendments');
      return;
    }

    if (amendments.length === 0) {
      this.logger.info('No amendments proposed');
      return;
    }

    // Step 3: Create amendments and hold votes
    const proposedAmendments = amendments.map(a =>
      this.worldState.proposeAmendment(a.description, 'ElectionManager')
    );

    await new Promise(r => setTimeout(r, Math.min(VOTING_DURATION_MS, 10_000)));

    for (const amendment of proposedAmendments) {
      const votePromises = agents.map(async (agent) => {
        try {
          const response = await this.llm.promptJSON<{ vote: boolean }>(
            `You are ${agent.profile.name}, with traits: ${agent.profile.traits.join(', ')}.`,
            `Proposed amendment: "${amendment.description}"

Current constitution:
${constitutionText}

Do you vote in favor of this amendment?
Respond as JSON: { "vote": true } or { "vote": false }`
          );
          this.worldState.vote(amendment.id, agent.profile.name, response?.vote === true);
        } catch {
          this.worldState.vote(amendment.id, agent.profile.name, Math.random() > 0.5);
        }
      });

      await Promise.all(votePromises);

      // Step 4: Resolve
      const passed = this.worldState.resolveAmendment(amendment.id, agents.length);
      this.logger.info(
        `Amendment ${amendment.id} "${amendment.description}" — ${passed ? 'PASSED' : 'FAILED'} ` +
        `(${amendment.votesFor.length} for, ${amendment.votesAgainst.length} against)`
      );
    }

    this.logger.info(`=== Election ${this.electionCount} complete ===`);
  }

  getElectionCount(): number { return this.electionCount; }
}
