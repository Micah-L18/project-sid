/**
 * AgentState — The central shared state object for a single PIANO agent.
 *
 * Every module reads from and writes to this structure. The ModuleRunner
 * ensures controlled concurrent access. This is the "shared Agent State"
 * described in the Project Sid paper.
 */

import { Vec3 } from 'vec3';

// ── Identity ─────────────────────────────────────────────────────────────────

export interface AgentIdentity {
  name: string;
  traits: string[];
  communityGoal: string;
  spawnLocation: Vec3;
  /** Agent's biography / backstory, generated or configured */
  backstory: string;
}

// ── Memory ───────────────────────────────────────────────────────────────────

export type MemoryType = 'observation' | 'conversation' | 'action' | 'reflection' | 'social';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  timestamp: number;
  /** Importance score 1-10, determined by LLM or heuristic */
  importance: number;
  /** Embedding vector for similarity search */
  embedding?: number[];
  /** Associated agent names */
  agents?: string[];
  /** Associated location */
  location?: Vec3;
}

export interface AgentMemory {
  /** Current tick's perception + last decision — ephemeral, reset each cycle */
  workingMemory: string[];
  /** Rolling buffer of recent events (last ~50) */
  shortTermMemory: MemoryEntry[];
  /** Persistent vector-indexed storage */
  longTermMemory: MemoryEntry[];
  /** Max STM entries before promotion/pruning */
  stmCapacity: number;
}

// ── Perception ───────────────────────────────────────────────────────────────

export interface NearbyEntity {
  name: string;
  type: string; // 'player' | 'mob' | 'item' | etc.
  position: Vec3;
  distance: number;
  health?: number;
}

export interface NearbyBlock {
  name: string;
  position: Vec3;
  distance: number;
}

export interface ChatEntry {
  sender: string;
  message: string;
  timestamp: number;
  /** Was this heard via proximity (true) or whisper (false)? */
  isProximity: boolean;
}

export interface InventoryItem {
  name: string;
  count: number;
  slot: number;
}

export interface AgentPerception {
  /** Entities within perception radius */
  nearbyEntities: NearbyEntity[];
  /** Notable blocks within perception radius */
  nearbyBlocks: NearbyBlock[];
  /** Current inventory */
  inventory: InventoryItem[];
  /** Health (0-20) */
  health: number;
  /** Food level (0-20) */
  food: number;
  /** Current position */
  position: Vec3;
  /** Whether it's day or night */
  isDay: boolean;
  /** Whether it's raining */
  isRaining: boolean;
  /** Game time (ticks) */
  gameTime: number;
  /** Recent chat messages (heard within proximity or whispered) */
  recentChat: ChatEntry[];
  /** Whether the agent is currently in water */
  isInWater: boolean;
  /** Oxygen level (0-300 ticks, 300 = full, 0 = drowning) */
  oxygenLevel: number;
  /** Timestamp of last perception update */
  lastUpdated: number;
}

// ── Social ───────────────────────────────────────────────────────────────────

export interface SocialRelationship {
  agentName: string;
  /** Sentiment score 0 (hostile) to 10 (best friend) */
  sentiment: number;
  /** One-line summary of the relationship */
  summary: string;
  /** Last interaction timestamp */
  lastInteraction: number;
  /** Known traits/info about this agent */
  knownTraits: string[];
}

export interface SocialGoal {
  id: string;
  description: string;
  targetAgent?: string;
  priority: number; // 1-10
  createdAt: number;
  /** Is this goal still active? */
  active: boolean;
}

export interface AgentSocial {
  /** Directed sentiment graph: agentName → relationship */
  relationships: Map<string, SocialRelationship>;
  /** Current social goals */
  socialGoals: SocialGoal[];
  /** Known agents in the world */
  knownAgents: string[];
}

// ── Goals ────────────────────────────────────────────────────────────────────

export type GoalCategory = 'survival' | 'social' | 'economic' | 'civic' | 'exploration' | 'religious';

export interface Goal {
  id: string;
  category: GoalCategory;
  description: string;
  priority: number; // 1-10
  createdAt: number;
  /** Sub-steps if decomposed */
  steps?: string[];
  /** Is this goal completed? */
  completed: boolean;
  /** Is this goal currently being pursued? */
  active: boolean;
}

export interface AgentGoals {
  /** Active goals, ordered by priority */
  currentGoals: Goal[];
  /** Recently completed goals (for reflection) */
  completedGoals: Goal[];
}

// ── Cognitive Decision ───────────────────────────────────────────────────────

export interface CognitiveDecision {
  /** High-level summary of what the agent decided to do */
  reasoning: string;
  /** The action to execute (null = idle) */
  action: ActionIntent | null;
  /** What to say (null = stay silent) */
  speech: string | null;
  /** Timestamp of this decision */
  timestamp: number;
}

export interface ActionIntent {
  type: ActionType;
  /** Parameters depend on type */
  params: Record<string, unknown>;
}

export type ActionType =
  | 'mine'        // { blockName, position }
  | 'craft'       // { itemName, count }
  | 'place'       // { blockName, position }
  | 'move'        // { destination: Vec3 }
  | 'follow'      // { targetName }
  | 'attack'      // { targetName }
  | 'eat'         // {}
  | 'deposit'     // { chestPosition, items }
  | 'withdraw'    // { chestPosition, items }
  | 'equip'       // { itemName }
  | 'idle'        // {}
  | 'explore'     // { direction? }
  | 'smelt'       // { itemName, count }
  | 'trade'       // { targetAgent, offer, request }
  | 'build'       // { blueprint }
  | 'custom';     // { code } — freeform Mineflayer JS

// ── Action Awareness ─────────────────────────────────────────────────────────

export interface ActionResult {
  /** The action that was attempted */
  action: ActionIntent;
  /** Did it succeed? */
  success: boolean;
  /** Human-readable outcome */
  outcome: string;
  /** Timestamp */
  timestamp: number;
  /** Duration in ms */
  durationMs: number;
}

export interface ActionAwareness {
  /** Last action result */
  lastResult: ActionResult | null;
  /** History of recent action results */
  recentResults: ActionResult[];
  /** Is an action currently being executed? */
  isBusy: boolean;
  /** Current action start time */
  busySince: number | null;
}

// ── Location Memory ──────────────────────────────────────────────────────────

export interface LocationMemory {
  description: string;
  position: Vec3;
  category: 'resource' | 'structure' | 'danger' | 'social' | 'other';
  discoveredAt: number;
}

// ── Full Agent State ─────────────────────────────────────────────────────────

export interface AgentState {
  identity: AgentIdentity;
  memory: AgentMemory;
  perception: AgentPerception;
  social: AgentSocial;
  goals: AgentGoals;
  cognitiveDecision: CognitiveDecision;
  actionAwareness: ActionAwareness;
  locationMemories: LocationMemory[];

  /** Simulation tick counter */
  tick: number;
  /** Agent creation timestamp */
  createdAt: number;
  /** Is the agent alive and connected? */
  isAlive: boolean;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createDefaultAgentState(identity: AgentIdentity): AgentState {
  const now = Date.now();
  return {
    identity,
    memory: {
      workingMemory: [],
      shortTermMemory: [],
      longTermMemory: [],
      stmCapacity: 50,
    },
    perception: {
      nearbyEntities: [],
      nearbyBlocks: [],
      inventory: [],
      health: 20,
      food: 20,
      position: identity.spawnLocation.clone(),
      isDay: true,
      isRaining: false,
      gameTime: 0,
      recentChat: [],
      isInWater: false,
      oxygenLevel: 300,
      lastUpdated: now,
    },
    social: {
      relationships: new Map(),
      socialGoals: [],
      knownAgents: [],
    },
    goals: {
      currentGoals: [],
      completedGoals: [],
    },
    cognitiveDecision: {
      reasoning: 'Just spawned, observing surroundings.',
      action: null,
      speech: null,
      timestamp: now,
    },
    actionAwareness: {
      lastResult: null,
      recentResults: [],
      isBusy: false,
      busySince: null,
    },
    locationMemories: [],
    tick: 0,
    createdAt: now,
    isAlive: true,
  };
}
