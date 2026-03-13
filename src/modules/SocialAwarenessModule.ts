/**
 * SocialAwarenessModule — Interprets social cues, tracks sentiment toward
 * other agents, maintains per-agent relationship summaries, and generates
 * social goals. Runs every ~5-10 seconds.
 *
 * This module implements the social graph from Project Sid:
 * - Directed sentiment graph (0-10 scale) between agents
 * - Per-agent summaries and known traits
 * - Social goal generation based on relationships
 */

import {
  AgentState,
  AgentSocial,
  SocialRelationship,
  SocialGoal,
} from '../agent/AgentState';
import { PianoModule, ModuleContext } from '../agent/ModuleRunner';
import { v4 as uuidv4 } from 'uuid';

// ── Prompts ──────────────────────────────────────────────────────────────────

const SENTIMENT_PROMPT = `You are evaluating the social relationship between two agents in a Minecraft community simulation.

Given the interaction history, evaluate the sentiment of {SELF} toward {OTHER}.

Respond with ONLY a JSON object:
{
  "sentiment": <number 0-10, where 0=hostile, 5=neutral, 10=best friend>,
  "summary": "<one-line description of the relationship>",
  "knownTraits": ["<trait1>", "<trait2>"]
}`;

const SOCIAL_GOALS_PROMPT = `You are {NAME}, a Minecraft agent with these traits: {TRAITS}.
Your community goal is: {COMMUNITY_GOAL}

Based on your current relationships and recent interactions, generate 1-3 social goals.
Social goals are things you want to do involving other agents (trade, cooperate, avoid, teach, etc.)

Current relationships:
{RELATIONSHIPS}

Recent interactions:
{RECENT_INTERACTIONS}

Respond with ONLY a JSON object:
{
  "goals": [
    {
      "description": "<what you want to do>",
      "targetAgent": "<agent name or null>",
      "priority": <1-10>
    }
  ]
}`;

// ── Module Implementation ────────────────────────────────────────────────────

export const SocialAwarenessModule: PianoModule = async (
  state: Readonly<AgentState>,
  context: ModuleContext
): Promise<Partial<AgentState>> => {
  const social: AgentSocial = {
    relationships: new Map(state.social.relationships),
    socialGoals: [...state.social.socialGoals],
    knownAgents: [...state.social.knownAgents],
  };

  // ── 1. Discover new agents from perception ──────────────────────────────

  const nearbyPlayers = state.perception.nearbyEntities
    .filter(e => e.type === 'player' && e.name !== context.agentName);

  for (const player of nearbyPlayers) {
    if (!social.knownAgents.includes(player.name)) {
      social.knownAgents.push(player.name);
    }
  }

  // Also discover agents from chat
  for (const chat of state.perception.recentChat) {
    if (chat.sender !== context.agentName && !social.knownAgents.includes(chat.sender)) {
      social.knownAgents.push(chat.sender);
    }
  }

  // ── 2. Update relationships for recently interacted agents ──────────────

  // Find agents we've recently interacted with (seen or chatted)
  const recentAgents = new Set<string>();
  for (const entity of nearbyPlayers) {
    recentAgents.add(entity.name);
  }
  for (const chat of state.perception.recentChat.slice(-10)) {
    if (chat.sender !== context.agentName) {
      recentAgents.add(chat.sender);
    }
  }

  // Update sentiment for up to 3 agents per tick to limit LLM calls
  const agentsToUpdate = Array.from(recentAgents).slice(0, 3);

  for (const agentName of agentsToUpdate) {
    const existing = social.relationships.get(agentName);

    // Gather interaction history for this agent
    const interactions = state.perception.recentChat
      .filter(c => c.sender === agentName || c.sender === context.agentName)
      .slice(-10)
      .map(c => `${c.sender}: "${c.message}"`)
      .join('\n');

    const memories = state.memory.shortTermMemory
      .filter(m => m.agents?.includes(agentName))
      .slice(-5)
      .map(m => m.content)
      .join('\n');

    const interactionContext = [interactions, memories].filter(Boolean).join('\n---\n');

    if (!interactionContext.trim()) {
      // No interaction data — create minimal relationship
      if (!existing) {
        social.relationships.set(agentName, {
          agentName,
          sentiment: 5, // Neutral default
          summary: `Met ${agentName} nearby.`,
          lastInteraction: Date.now(),
          knownTraits: [],
        });
      }
      continue;
    }

    try {
      const prompt = SENTIMENT_PROMPT
        .replace('{SELF}', context.agentName)
        .replace('{OTHER}', agentName);

      const result = await context.llm.promptJSON<{
        sentiment: number;
        summary: string;
        knownTraits: string[];
      }>(prompt, interactionContext, { maxTokens: 256, temperature: 0.4, model: context.agentModel, provider: context.agentProvider, host: context.agentHost });

      const relationship: SocialRelationship = {
        agentName,
        sentiment: Math.max(0, Math.min(10, result.sentiment)),
        summary: result.summary || existing?.summary || `Knows ${agentName}`,
        lastInteraction: Date.now(),
        knownTraits: result.knownTraits || existing?.knownTraits || [],
      };

      social.relationships.set(agentName, relationship);
    } catch {
      // Keep existing relationship or create neutral
      if (!existing) {
        social.relationships.set(agentName, {
          agentName,
          sentiment: 5,
          summary: `Encountered ${agentName}.`,
          lastInteraction: Date.now(),
          knownTraits: [],
        });
      }
    }
  }

  // ── 3. Generate social goals (every ~3 ticks to save LLM calls) ─────────

  if (state.tick % 3 === 0 && social.relationships.size > 0) {
    const relationshipSummaries = Array.from(social.relationships.values())
      .map(r => `- ${r.agentName}: sentiment ${r.sentiment}/10 — ${r.summary}`)
      .join('\n');

    const recentInteractions = state.perception.recentChat
      .slice(-10)
      .map(c => `${c.sender}: "${c.message}"`)
      .join('\n') || 'No recent interactions.';

    const prompt = SOCIAL_GOALS_PROMPT
      .replace('{NAME}', context.agentName)
      .replace('{TRAITS}', state.identity.traits.join(', '))
      .replace('{COMMUNITY_GOAL}', state.identity.communityGoal)
      .replace('{RELATIONSHIPS}', relationshipSummaries)
      .replace('{RECENT_INTERACTIONS}', recentInteractions);

    try {
      const result = await context.llm.promptJSON<{
        goals: Array<{ description: string; targetAgent?: string; priority: number }>;
      }>(
        'You are a social goal generator. Respond with valid JSON only.',
        prompt,
        { maxTokens: 512, temperature: 0.7, model: context.agentModel, provider: context.agentProvider, host: context.agentHost }
      );

      // Deactivate old social goals
      social.socialGoals.forEach(g => (g.active = false));

      // Create new social goals
      const newGoals: SocialGoal[] = (result.goals || []).map(g => ({
        id: uuidv4(),
        description: g.description,
        targetAgent: g.targetAgent || undefined,
        priority: Math.max(1, Math.min(10, g.priority)),
        createdAt: Date.now(),
        active: true,
      }));

      social.socialGoals = [
        ...social.socialGoals.filter(g => !g.active).slice(-10), // Keep last 10 inactive
        ...newGoals,
      ];
    } catch {
      // Keep existing goals
    }
  }

  return { social };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Summarize social state for other modules (e.g., CognitiveController).
 */
export function summarizeSocial(social: AgentSocial): string {
  if (social.relationships.size === 0) {
    return 'No known relationships.';
  }

  const lines: string[] = [];

  // Relationships
  const relationships = Array.from(social.relationships.values())
    .sort((a, b) => b.sentiment - a.sentiment);

  lines.push('Relationships:');
  for (const r of relationships.slice(0, 8)) {
    const sentimentLabel =
      r.sentiment >= 8 ? 'close friend' :
      r.sentiment >= 6 ? 'friendly' :
      r.sentiment >= 4 ? 'neutral' :
      r.sentiment >= 2 ? 'unfriendly' : 'hostile';
    lines.push(`  ${r.agentName}: ${sentimentLabel} (${r.sentiment}/10) — ${r.summary}`);
  }

  // Active social goals
  const activeGoals = social.socialGoals.filter(g => g.active);
  if (activeGoals.length > 0) {
    lines.push('Social goals:');
    for (const g of activeGoals) {
      lines.push(`  - ${g.description}${g.targetAgent ? ` (with ${g.targetAgent})` : ''}`);
    }
  }

  return lines.join('\n');
}
