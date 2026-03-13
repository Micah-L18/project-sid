/**
 * MemoryModule — Three-tier memory system (WM / STM / LTM).
 *
 * Working Memory: Current tick's perception + last decision (ephemeral).
 * Short-Term Memory: Rolling buffer of ~50 recent events with timestamps.
 * Long-Term Memory: Vector-indexed persistent storage using embeddings.
 *
 * On each tick (every ~5s), the module:
 * 1. Refreshes working memory from current perception
 * 2. Creates new STM entries from recent observations/interactions
 * 3. Promotes important STM entries to LTM (importance >= 6)
 * 4. Prunes oldest STM entries when over capacity
 *
 * Retrieval uses recency + relevance weighting (inspired by Generative Agents).
 */

import { AgentState, AgentMemory, MemoryEntry, MemoryType } from '../agent/AgentState';
import { PianoModule, ModuleContext } from '../agent/ModuleRunner';
import { summarizePerception } from './PerceptionModule';
import { v4 as uuidv4 } from 'uuid';

// ── Configuration ────────────────────────────────────────────────────────────

const STM_CAPACITY = 50;
const LTM_PROMOTION_THRESHOLD = 6;  // importance >= this gets promoted to LTM
const MAX_LTM_SIZE = 500;
const EMBEDDING_ENABLED = true;      // Set false to skip embedding calls, saves cost
const IMPORTANCE_PROMPT = `Rate the importance of the following memory on a scale of 1-10, where:
1 = mundane/routine (walking, looking around)
5 = moderately notable (found resources, had a brief conversation)
8 = very important (made a deal, learned something crucial, changed goals)
10 = life-changing (near death, major discovery, formed alliance)

Respond with ONLY a JSON object: {"importance": <number>, "summary": "<one-line summary>"}`;

// ── Module Implementation ────────────────────────────────────────────────────

export const MemoryModule: PianoModule = async (
  state: Readonly<AgentState>,
  context: ModuleContext
): Promise<Partial<AgentState>> => {
  const memory: AgentMemory = {
    workingMemory: [...state.memory.workingMemory],
    shortTermMemory: [...state.memory.shortTermMemory],
    longTermMemory: [...state.memory.longTermMemory],
    stmCapacity: state.memory.stmCapacity,
  };

  // ── 1. Refresh Working Memory ────────────────────────────────────────────

  const perceptionSummary = summarizePerception(state.perception);
  const decisionSummary = state.cognitiveDecision.reasoning || 'No active decision';
  const actionSummary = state.actionAwareness.lastResult
    ? `Last action: ${state.actionAwareness.lastResult.action.type} — ${state.actionAwareness.lastResult.outcome}`
    : 'No recent actions';

  memory.workingMemory = [
    perceptionSummary,
    `Current plan: ${decisionSummary}`,
    actionSummary,
  ];

  // ── 2. Create new STM entries from recent events ─────────────────────────

  const newEntries: MemoryEntry[] = [];

  // Conversations heard since last memory tick
  const lastMemoryUpdate = state.memory.shortTermMemory.length > 0
    ? state.memory.shortTermMemory[state.memory.shortTermMemory.length - 1].timestamp
    : state.createdAt;

  for (const chat of state.perception.recentChat) {
    if (chat.timestamp > lastMemoryUpdate) {
      newEntries.push({
        id: uuidv4(),
        type: 'conversation',
        content: `${chat.sender} said: "${chat.message}"`,
        timestamp: chat.timestamp,
        importance: 5, // Default, will be evaluated
        agents: [chat.sender],
      });
    }
  }

  // Action results since last tick
  if (state.actionAwareness.lastResult &&
      state.actionAwareness.lastResult.timestamp > lastMemoryUpdate) {
    const result = state.actionAwareness.lastResult;
    newEntries.push({
      id: uuidv4(),
      type: 'action',
      content: `Attempted ${result.action.type}: ${result.outcome}`,
      timestamp: result.timestamp,
      importance: result.success ? 4 : 6, // Failures are more notable
    });
  }

  // Periodic observation snapshot (every other tick)
  if (state.tick % 2 === 0 && state.perception.nearbyEntities.length > 0) {
    const nearbyNames = state.perception.nearbyEntities
      .filter(e => e.type === 'player')
      .map(e => e.name);

    if (nearbyNames.length > 0) {
      newEntries.push({
        id: uuidv4(),
        type: 'observation',
        content: `Nearby agents: ${nearbyNames.join(', ')} at position (${Math.round(state.perception.position.x)}, ${Math.round(state.perception.position.y)}, ${Math.round(state.perception.position.z)})`,
        timestamp: Date.now(),
        importance: 3,
        agents: nearbyNames,
        location: state.perception.position.clone(),
      });
    }
  }

  // ── 3. Evaluate importance of new entries via LLM ────────────────────────

  for (const entry of newEntries) {
    try {
      const result = await context.llm.promptJSON<{ importance: number; summary: string }>(
        IMPORTANCE_PROMPT,
        entry.content,
        { maxTokens: 128, temperature: 0.3, model: context.agentModel, provider: context.agentProvider, host: context.agentHost }
      );
      entry.importance = Math.max(1, Math.min(10, result.importance));
      // Optionally replace content with summary for compactness
      if (result.summary && result.summary.length < entry.content.length) {
        entry.content = result.summary;
      }
    } catch {
      // Keep default importance if LLM fails
    }
  }

  // ── 4. Add new entries to STM ────────────────────────────────────────────

  memory.shortTermMemory.push(...newEntries);

  // ── 5. Promote important STM → LTM ──────────────────────────────────────

  const toPromote: MemoryEntry[] = [];
  memory.shortTermMemory = memory.shortTermMemory.filter(entry => {
    if (entry.importance >= LTM_PROMOTION_THRESHOLD) {
      toPromote.push(entry);
      return false; // Remove from STM
    }
    return true;
  });

  // Generate embeddings for promoted entries
  if (EMBEDDING_ENABLED && toPromote.length > 0) {
    try {
      const texts = toPromote.map(e => e.content);
      const embeddings = await context.llm.embedBatch(texts);
      for (let i = 0; i < toPromote.length; i++) {
        toPromote[i].embedding = embeddings[i];
      }
    } catch {
      // Continue without embeddings
    }
  }

  memory.longTermMemory.push(...toPromote);

  // ── 6. Prune STM if over capacity ───────────────────────────────────────

  if (memory.shortTermMemory.length > STM_CAPACITY) {
    // Keep the most recent entries
    memory.shortTermMemory = memory.shortTermMemory
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, STM_CAPACITY);
  }

  // ── 7. Prune LTM if over capacity ───────────────────────────────────────

  if (memory.longTermMemory.length > MAX_LTM_SIZE) {
    // Keep highest importance entries
    memory.longTermMemory = memory.longTermMemory
      .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
      .slice(0, MAX_LTM_SIZE);
  }

  return { memory };
};

// ── Retrieval Functions ──────────────────────────────────────────────────────

/**
 * Retrieve relevant memories using a weighted combination of
 * recency, importance, and relevance (cosine similarity).
 */
export async function retrieveMemories(
  memory: AgentMemory,
  query: string,
  llm: { embed: (text: string) => Promise<number[]> },
  topK: number = 5,
  weights: { recency: number; importance: number; relevance: number } = {
    recency: 0.3,
    importance: 0.3,
    relevance: 0.4,
  }
): Promise<MemoryEntry[]> {
  const allMemories = [...memory.shortTermMemory, ...memory.longTermMemory];
  if (allMemories.length === 0) return [];

  // Compute query embedding
  let queryEmbedding: number[] | null = null;
  if (weights.relevance > 0) {
    try {
      queryEmbedding = await llm.embed(query);
    } catch {
      // Fall back to recency + importance only
      weights.relevance = 0;
      const total = weights.recency + weights.importance;
      weights.recency /= total;
      weights.importance /= total;
    }
  }

  const now = Date.now();
  const maxAge = now - (allMemories[0]?.timestamp ?? now); // Age of oldest memory

  const scored = allMemories.map(entry => {
    // Recency: exponential decay, half-life of 5 minutes
    const ageMs = now - entry.timestamp;
    const recencyScore = Math.exp(-ageMs / (5 * 60 * 1000));

    // Importance: normalized 0-1
    const importanceScore = entry.importance / 10;

    // Relevance: cosine similarity
    let relevanceScore = 0;
    if (queryEmbedding && entry.embedding) {
      relevanceScore = cosineSimilarity(queryEmbedding, entry.embedding);
    }

    const totalScore =
      weights.recency * recencyScore +
      weights.importance * importanceScore +
      weights.relevance * relevanceScore;

    return { entry, score: totalScore };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.entry);
}

/**
 * Simple text-based retrieval (no embeddings needed).
 */
export function retrieveMemoriesByKeyword(
  memory: AgentMemory,
  keywords: string[],
  topK: number = 5
): MemoryEntry[] {
  const allMemories = [...memory.shortTermMemory, ...memory.longTermMemory];
  const lowerKeywords = keywords.map(k => k.toLowerCase());

  return allMemories
    .filter(entry => lowerKeywords.some(k => entry.content.toLowerCase().includes(k)))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, topK);
}

// ── Utilities ────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

export const MemoryConfig = {
  STM_CAPACITY,
  LTM_PROMOTION_THRESHOLD,
  MAX_LTM_SIZE,
  EMBEDDING_ENABLED,
};
