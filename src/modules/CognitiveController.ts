/**
 * CognitiveController — The bottleneck decision-maker with multi-step planning.
 *
 * This is the core of the PIANO architecture's coherence mechanism. It:
 * 1. Reads a compressed summary of the full agent state (information bottleneck)
 * 2. Produces a multi-step TaskPlan (1-5 actions) via a single LLM call
 * 3. On subsequent ticks, feeds the next step from the plan WITHOUT calling the LLM
 * 4. Re-plans only when: plan is exhausted, a step fails repeatedly, or an urgent
 *    interrupt occurs (low health, being attacked, someone talking)
 *
 * This prevents the "flip-flop" problem where the agent re-decides every 3 seconds
 * and loses track of multi-step goals like crafting a pickaxe.
 *
 * Runs every ~2-3 seconds.
 */

import { AgentState, CognitiveDecision, ActionIntent, ActionType, TaskPlan, PlannedStep } from '../agent/AgentState';
import { PianoModule, ModuleContext } from '../agent/ModuleRunner';
import { summarizePerception, getProgressionStatus } from './PerceptionModule';
import { summarizeSocial } from './SocialAwarenessModule';
import { summarizeGoals } from './GoalGenerationModule';
import { Logger } from '../utils/Logger';

const ccLogger = new Logger('CC');

// Track the timestamp of the last chat message we already responded to,
// so the CONVERSATION interrupt only fires once per new message.
let lastHandledChatTimestamp = 0;

// ── Minecraft game rules injected into every decision ───────────────────

const MINECRAFT_RULES = `
MINECRAFT SURVIVAL RULES (follow these exactly):
1. Bare hands can break: leaves, grass, dirt, sand, gravel, and ANY type of log (oak_log, birch_log, spruce_log, jungle_log, acacia_log, dark_oak_log). No tool needed.
2. You CANNOT get drops from stone, coal_ore, iron_ore or any ore without a pickaxe. Attempting it wastes time.
3. TECH TREE (must follow in order):
   → Punch ANY nearby log with bare hands → craft planks (4 per log, no table) → craft sticks (2 planks = 4 sticks)
   → craft crafting_table (4 planks, no table) → place crafting_table nearby
   → craft wooden_pickaxe (3 planks + 2 sticks at table) → mine stone/coal_ore
   → craft stone_pickaxe (3 cobblestone + 2 sticks at table) → mine iron_ore
   → smelt iron_ore in furnace → craft iron_pickaxe → mine gold/diamond
4. CRAFTING RECIPES:
   - planks: 1 log (any type) → 4 planks (no table). Use the planks type matching the log you have.
   - sticks: 2 planks → 4 sticks (no table)
   - crafting_table: 4 planks in 2×2 grid (no table)
   - wooden_pickaxe: 3 planks (top row) + 2 sticks (middle column) at crafting_table
   - stone_pickaxe: 3 cobblestone (top row) + 2 sticks (middle column) at crafting_table
   - furnace: 8 cobblestone in ring at crafting_table
   - torch: 1 coal + 1 stick at crafting_table → 4 torches
5. PRIORITY ORDER when you have nothing: wood → planks → table → wooden_pickaxe → mine stone → stone_pickaxe → mine iron
6. Your current tech tier and what you can/cannot do is shown in the Progression section below.
7. NEVER choose mine: coal_ore / stone / iron_ore if you lack the required pickaxe. Craft the pickaxe first.
8. If your last action failed with "CANNOT mine" or "need at least", your immediate next action MUST be to craft the required tool.

ENVIRONMENT AWARENESS — use what's around you:
- LOOK AT YOUR NEARBY BLOCKS to see what resources are actually available. Use those, don't assume oak.
- Any log type works for wood. Mine whichever type of log you can see nearby (oak_log, birch_log, spruce_log, etc.).
- Any planks type works for crafting. Use the planks that match the logs you gathered.
- TREES grow on the SURFACE. Y ≈ 60-80. Go UP or stay on surface level to find them.
- STONE is found just below the surface, starting at Y ≈ 55-60. Dig DOWN a few blocks from surface.
- COAL ORE spawns at Y = 0-128, most common around Y = 48-96. Found in stone layers.
- IRON ORE spawns at Y = -64 to 72, most common around Y = 16. Look inside caves or dig down.
- GOLD ORE spawns at Y = -64 to 32, most common around Y = -16 (deep underground).
- DIAMOND ORE spawns at Y = -64 to 16, most common around Y = -59 (very deep).
- If you need wood but see no logs nearby, explore on the SURFACE (move, keeping Y ≈ 64) — do NOT dig down.
- If you need ores, look for caves at your current Y level or dig down.
- Pay attention to the Y coordinate in your position and nearby block positions.

ACTION-SPEECH COHERENCE:
- Your speech MUST match your action. If you say "I'll get wood", your action MUST be to mine a log type visible nearby.
- Do NOT say you will do something in your speech and then choose a different action.
- If your action is craft, say you're crafting. If exploring, say you're exploring. No contradictions.
- Prefer short, useful speech. Don't narrate what you can't actually do.`;

// ── Plan prompt ──────────────────────────────────────────────────────────────

const CC_PLAN_PROMPT = `You are the decision-making core of {NAME}, a Minecraft agent.
Your traits: {TRAITS}
Community goal: {COMMUNITY_GOAL}
{MINECRAFT_RULES}

You receive a summary of your current state and must produce a PLAN of 1-5 sequential steps to accomplish your most important current objective.
Each step is a concrete action the agent will execute in order. Think about what you need to accomplish RIGHT NOW and break it down into the specific steps required.

Available action types:
- mine: Mine a specific block (params: blockName)
- craft: Craft an item (params: itemName, count)
- place: Place a block (params: blockName)
- move: Move to a location (params: x, y, z) or toward a nearby entity
- follow: Follow a player or agent (params: targetName) — use this when someone asks you to come to them
- attack: Attack a mob or entity (params: targetName)
- eat: Eat food from inventory
- deposit: Put items in a chest (params: itemName, count)
- withdraw: Take items from a chest (params: itemName, count)
- equip: Equip an item (params: itemName)
- explore: Explore in a direction
- smelt: Smelt items in a furnace (params: itemName, count)
- trade: Propose a trade to another agent (params: targetAgent, offer, request)
- idle: Do nothing, wait and observe
- build: Build a structure (params: description)

Rules:
- Produce 1-5 steps. Each step must have a "description" (human-readable) and an "action" with "type" and "params".
- Steps execute in order — plan dependencies properly (e.g., mine logs BEFORE crafting planks).
- Only plan actions you can actually perform given your current inventory and surroundings.
- If someone is talking to you, prioritize responding to them.
- When a player asks you to "come here", "come to me", "follow me", or similar — use the "follow" action with their name as targetName. This is your TOP priority when someone requests it.
- When a player gives you instructions (mine something, build something, go somewhere), follow their instructions.
- If your health or food is low, prioritize survival steps first.
- Work toward your highest-priority goal.
- Be true to your personality traits.
- You may include speech in the FIRST step only.
- NEVER craft an item you already have in your inventory or have already placed in the world (check Nearby Blocks). For example, do NOT craft crafting_table if one is already nearby.
- If a goal is already satisfied by your inventory or placed blocks, SKIP it and work on the next goal.

Respond with ONLY a valid JSON object (no markdown, no extra text, no thinking).
Example:
{"goal": "Craft a wooden pickaxe", "speech": "Time to make a pickaxe!", "steps": [{"description": "Mine nearby logs for wood", "action": {"type": "mine", "params": {"blockName": "birch_log"}}}, {"description": "Craft planks from logs", "action": {"type": "craft", "params": {"itemName": "birch_planks", "count": 1}}}, {"description": "Craft sticks from planks", "action": {"type": "craft", "params": {"itemName": "stick", "count": 1}}}, {"description": "Craft the wooden pickaxe", "action": {"type": "craft", "params": {"itemName": "wooden_pickaxe", "count": 1}}}]}

IMPORTANT: The example uses birch_log but you should use whatever log type is listed in your Nearby Blocks. Any log type works.

The "speech" field can be null if you have nothing to say. "goal" is a short label for the overall plan.`;

// ── Urgency Detection ────────────────────────────────────────────────────────

function detectUrgentInterrupt(state: Readonly<AgentState>): string | null {
  // Low health — need to eat or flee
  if (state.perception.health <= 8) {
    return 'LOW_HEALTH';
  }
  // Very hungry — need food
  if (state.perception.food <= 4) {
    return 'STARVING';
  }
  // Being attacked — hostile mob very close
  const hostileMobs = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'pillager', 'drowned'];
  const nearbyHostile = state.perception.nearbyEntities.find(
    e => hostileMobs.some(m => e.type.toLowerCase().includes(m)) && e.distance < 5
  );
  if (nearbyHostile) {
    return `UNDER_ATTACK:${nearbyHostile.name}`;
  }
  // Someone is talking to us (new unhandled chat within last 30s)
  const now = Date.now();
  const recentChat = state.perception.recentChat.filter(
    c => c.sender !== state.identity.name && now - c.timestamp < 30_000 && c.timestamp > lastHandledChatTimestamp
  );
  if (recentChat.length > 0) {
    return `CONVERSATION:${recentChat[0].sender}`;
  }
  // Drowning
  if (state.perception.isInWater && state.perception.oxygenLevel < 200) {
    return 'DROWNING';
  }
  return null;
}

// ── Valid actions list ───────────────────────────────────────────────────────

const VALID_ACTIONS: ActionType[] = [
  'mine', 'craft', 'place', 'move', 'follow', 'attack', 'eat',
  'deposit', 'withdraw', 'equip', 'idle', 'explore', 'smelt',
  'trade', 'build', 'custom',
];

// ── Lenient Response Extraction ──────────────────────────────────────────────
// When models (like Andy-4) can't produce the exact JSON schema, try to extract
// useful actions and speech from whatever text they did produce.

interface LooseExtractionResult {
  goal: string;
  speech: string | null;
  steps: PlannedStep[];
}

// Log types in preference order — used to find whatever wood is nearby
const ALL_LOG_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];
const ALL_PLANKS_TYPES = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'];

/** Find the nearest visible log type from perception, or return first available. */
function findNearestLogType(state: Readonly<AgentState>): string {
  const nearby = state.perception.nearbyBlocks;
  for (const block of nearby) {
    if (block.name.endsWith('_log')) return block.name;
  }
  // No logs visible — return generic oak_log as last resort
  return 'oak_log';
}

/** Find the planks type matching the logs we have in inventory, or nearby logs. */
function findMatchingPlanks(state: Readonly<AgentState>): string {
  // Check inventory for any log type and match planks
  for (const item of state.perception.inventory) {
    const logIdx = ALL_LOG_TYPES.indexOf(item.name);
    if (logIdx >= 0) return ALL_PLANKS_TYPES[logIdx];
  }
  // Check nearby blocks
  for (const block of state.perception.nearbyBlocks) {
    const logIdx = ALL_LOG_TYPES.indexOf(block.name);
    if (logIdx >= 0) return ALL_PLANKS_TYPES[logIdx];
  }
  return 'oak_planks';
}

const BLOCK_PATTERNS: Array<{ pattern: RegExp; blockName: string }> = [
  { pattern: /punch.*(?:tree|log|wood)|chop.*(?:tree|wood)|get.*wood|gather.*wood|collect.*wood|mine.*log/i, blockName: '__NEAREST_LOG__' },
  { pattern: /oak_log/i, blockName: 'oak_log' },
  { pattern: /birch_log/i, blockName: 'birch_log' },
  { pattern: /spruce_log/i, blockName: 'spruce_log' },
  { pattern: /jungle_log/i, blockName: 'jungle_log' },
  { pattern: /acacia_log/i, blockName: 'acacia_log' },
  { pattern: /dark_oak_log/i, blockName: 'dark_oak_log' },
  { pattern: /stone(?!_)|cobblestone|mine.*stone/i, blockName: 'stone' },
  { pattern: /coal_ore|mine.*coal/i, blockName: 'coal_ore' },
  { pattern: /iron_ore|mine.*iron/i, blockName: 'iron_ore' },
  { pattern: /dirt/i, blockName: 'dirt' },
  { pattern: /sand(?!stone)/i, blockName: 'sand' },
];

const CRAFT_PATTERNS: Array<{ pattern: RegExp; itemName: string }> = [
  { pattern: /craft.*plank|make.*plank|planks/i, itemName: '__MATCHING_PLANKS__' },
  { pattern: /craft.*table|crafting_table/i, itemName: 'crafting_table' },
  { pattern: /craft.*stick|make.*stick/i, itemName: 'stick' },
  { pattern: /wooden_pickaxe|wood.*pickaxe|craft.*pickaxe/i, itemName: 'wooden_pickaxe' },
  { pattern: /stone_pickaxe/i, itemName: 'stone_pickaxe' },
  { pattern: /iron_pickaxe/i, itemName: 'iron_pickaxe' },
  { pattern: /furnace/i, itemName: 'furnace' },
  { pattern: /torch/i, itemName: 'torch' },
];

/** Resolve sentinel values like __NEAREST_LOG__ in step params using actual perception. */
function resolveStepSentinels(steps: PlannedStep[], state: Readonly<AgentState>): PlannedStep[] {
  return steps.map(step => {
    const params = { ...step.action.params };
    let description = step.description;
    for (const key of Object.keys(params)) {
      if (params[key] === '__NEAREST_LOG__') {
        params[key] = findNearestLogType(state);
      } else if (params[key] === '__MATCHING_PLANKS__') {
        params[key] = findMatchingPlanks(state);
      }
    }
    // Also resolve sentinels in description text
    description = description
      .replace(/__NEAREST_LOG__/g, findNearestLogType(state))
      .replace(/__MATCHING_PLANKS__/g, findMatchingPlanks(state));
    return { description, action: { ...step.action, params } };
  });
}

function extractLooseResponse(result: Record<string, unknown>): LooseExtractionResult | null {
  const allText = extractAllStrings(result).join(' ');
  if (!allText || allText.length < 5) return null;

  const steps: PlannedStep[] = [];
  let goal = 'extracted plan';
  let speech: string | null = null;

  // Try to pull a goal string from common keys
  for (const key of ['goal', 'objective', 'plan', 'task', 'summary']) {
    if (typeof result[key] === 'string' && (result[key] as string).length > 3) {
      goal = (result[key] as string).replace(/<[^>]+>/g, '').trim().substring(0, 100);
      break;
    }
  }

  // Try to extract speech from common keys
  for (const key of ['speech', 'message', 'say', 'chat', 'response', 'text']) {
    if (typeof result[key] === 'string' && (result[key] as string).trim().length > 2) {
      speech = (result[key] as string).replace(/<[^>]+>/g, '').trim().substring(0, 200);
      break;
    }
  }

  // Look for action-like nested objects anywhere in the result
  const actionObjects = findActionObjects(result);
  for (const ao of actionObjects) {
    if (VALID_ACTIONS.includes(ao.type as ActionType)) {
      steps.push({
        description: ao.description || ao.type,
        action: { type: ao.type as ActionType, params: ao.params },
      });
    }
  }

  // If no structured actions found, try to infer from text
  if (steps.length === 0) {
    // Collect ALL matching block patterns (not just the first)
    const seenMineBlocks = new Set<string>();
    for (const bp of BLOCK_PATTERNS) {
      if (bp.pattern.test(allText) && !seenMineBlocks.has(bp.blockName)) {
        seenMineBlocks.add(bp.blockName);
        steps.push({
          description: `Mine ${bp.blockName}`,
          action: { type: 'mine', params: { blockName: bp.blockName } },
        });
      }
    }

    // Collect ALL matching craft patterns (not just the first)
    const seenCraftItems = new Set<string>();
    for (const cp of CRAFT_PATTERNS) {
      if (cp.pattern.test(allText) && !seenCraftItems.has(cp.itemName)) {
        seenCraftItems.add(cp.itemName);
        steps.push({
          description: `Craft ${cp.itemName}`,
          action: { type: 'craft', params: { itemName: cp.itemName, count: 1 } },
        });
      }
    }

    if (/explore|wander|look around|scout/i.test(allText) && steps.length === 0) {
      steps.push({
        description: 'Explore the area',
        action: { type: 'explore', params: {} },
      });
    }

    if (/eat|hungry|food|starv/i.test(allText)) {
      steps.push({
        description: 'Eat food',
        action: { type: 'eat', params: {} },
      });
    }

    const attackMatch = allText.match(/(?:attack|fight|kill)\s+(\w+)/i);
    if (attackMatch) {
      steps.push({
        description: `Attack ${attackMatch[1]}`,
        action: { type: 'attack', params: { targetName: attackMatch[1] } },
      });
    }

    // Follow / come-to / go-to player patterns
    const followMatch = allText.match(/(?:follow|come to|go to|walk to|move to|approach)\s+([A-Za-z0-9_]+)/i);
    if (followMatch) {
      steps.push({
        description: `Follow ${followMatch[1]}`,
        action: { type: 'follow', params: { targetName: followMatch[1] } },
      });
    }

    // Cap extracted steps and order: mine steps first, then craft steps
    // (dependencies: you need to mine before you can craft)
    const mineSteps = steps.filter(s => s.action.type === 'mine');
    const craftSteps = steps.filter(s => s.action.type === 'craft');
    const otherSteps = steps.filter(s => s.action.type !== 'mine' && s.action.type !== 'craft');
    steps.length = 0;
    steps.push(...mineSteps, ...craftSteps, ...otherSteps);
    // trim to 5 steps max
    if (steps.length > 5) steps.length = 5;
  }

  if (steps.length === 0 && !speech) return null;

  // Try to extract speech from quoted text if we didn't find it in a key
  if (!speech && allText.length > 10) {
    const quoteMatch = allText.match(/"([^"]{3,80})"/);
    if (quoteMatch) {
      speech = quoteMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  return { goal, speech, steps };
}

function extractAllStrings(obj: unknown): string[] {
  const strings: string[] = [];
  if (typeof obj === 'string') {
    strings.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) strings.push(...extractAllStrings(item));
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      strings.push(...extractAllStrings(val));
    }
  }
  return strings;
}

function findActionObjects(obj: unknown): Array<{ type: string; params: Record<string, unknown>; description: string }> {
  const results: Array<{ type: string; params: Record<string, unknown>; description: string }> = [];
  if (!obj || typeof obj !== 'object') return results;

  if (!Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.type === 'string' && rec.type.length > 0) {
      results.push({
        type: rec.type,
        params: (typeof rec.params === 'object' && rec.params !== null ? rec.params : {}) as Record<string, unknown>,
        description: typeof rec.description === 'string' ? rec.description : rec.type,
      });
    }
    if (rec.action && typeof rec.action === 'object') {
      results.push(...findActionObjects(rec.action));
    }
    for (const val of Object.values(rec)) {
      if (val && typeof val === 'object') {
        results.push(...findActionObjects(val));
      }
    }
  } else {
    for (const item of obj) {
      results.push(...findActionObjects(item));
    }
  }
  return results;
}

// ── Build state context string ───────────────────────────────────────────────

function buildStateContext(state: Readonly<AgentState>, planContext?: string): string {
  const perception = summarizePerception(state.perception);
  const progression = getProgressionStatus(state.perception.inventory, state.perception.nearbyBlocks);
  const social = summarizeSocial(state.social);
  const goals = summarizeGoals(state.goals);

  const recentActions = state.actionAwareness.recentResults
    .slice(-5)
    .map(r => `${r.action.type}: ${r.success ? '✓' : '✗'} ${r.outcome}`)
    .join('\n') || 'No recent actions.';

  const socialGoals = state.social.socialGoals
    .filter(g => g.active)
    .map(g => `- ${g.description}`)
    .join('\n') || 'None';

  // Show recently completed goals so the LLM doesn't re-plan them
  const completedGoalsSummary = state.goals.completedGoals
    .slice(-5)
    .map(g => `- ✓ ${g.description}`)
    .join('\n') || 'None';

  let ctx = `== Perception ==
${perception}

== Progression ==
${progression}

== Goals (by priority) ==
${goals}

== Already Completed Goals (DO NOT re-do these) ==
${completedGoalsSummary}

== Social ==
${social}

== Social Goals ==
${socialGoals}

== Recent Actions ==
${recentActions}

== Key Memories ==
${state.memory.shortTermMemory.slice(-5).map(m => `- ${m.content}`).join('\n') || 'None'}`;

  if (planContext) {
    ctx += `\n\n== Plan Context ==\n${planContext}`;
  }

  ctx += `\n\nBased on the above state, produce a multi-step PLAN (1-5 steps). Reply ONLY with a JSON object containing "goal", "speech", and "steps" fields.`;

  return ctx;
}

// ── Direct Player Command Detection ──────────────────────────────────────────
// Bypasses the LLM entirely for common player requests. This ensures the agent
// responds reliably even when the LLM returns garbage.

interface DirectCommand {
  plan: TaskPlan;
  speech: string;
}

function detectDirectCommand(state: Readonly<AgentState>): DirectCommand | null {
  const now = Date.now();
  const agentName = state.identity.name.toLowerCase();
  
  // Find recent unhandled chat from non-agent senders (within 30s)
  const recentPlayerChat = state.perception.recentChat.filter(
    c => c.sender !== state.identity.name 
      && now - c.timestamp < 30_000 
      && c.timestamp > lastHandledChatTimestamp
  );
  
  if (recentPlayerChat.length === 0) return null;
  
  // Check the most recent message
  const latest = recentPlayerChat[recentPlayerChat.length - 1];
  const msg = latest.message.toLowerCase();
  const sender = latest.sender;
  
  // ── "come here" / "follow me" / "come to me" patterns ──
  const followPatterns = [
    /come\s*(?:here|to\s*me|over)/i,
    /follow\s*me/i,
    /get\s*(?:over|here)/i,
    /come\s*(?:on|with)/i,
    /walk\s*(?:to|over|here|with)/i,
    /tp\s*(?:to|here)/i,
  ];
  
  for (const pattern of followPatterns) {
    if (pattern.test(msg)) {
      // Mark handled
      lastHandledChatTimestamp = latest.timestamp;
      return {
        speech: `On my way, ${sender}!`,
        plan: {
          goal: `Go to ${sender}`,
          steps: [
            { description: `Follow ${sender}`, action: { type: 'follow' as ActionType, params: { targetName: sender } } },
          ],
          currentStepIndex: 0,
          createdAt: now,
          failureCount: 0,
        },
      };
    }
  }
  
  // ── "stop" / "stay" patterns ──
  if (/\b(?:stop|stay|wait|halt|don'?t move)\b/i.test(msg)) {
    lastHandledChatTimestamp = latest.timestamp;
    return {
      speech: `Okay, I'll wait here.`,
      plan: {
        goal: 'Wait',
        steps: [
          { description: 'Idle and wait', action: { type: 'idle' as ActionType, params: {} } },
        ],
        currentStepIndex: 0,
        createdAt: now,
        failureCount: 0,
      },
    };
  }
  
  // ── "mine <block>" patterns ──
  const mineMatch = msg.match(/(?:mine|dig|get|gather|collect|punch|chop|break)\s+(?:some\s+)?(\w+)/i);
  if (mineMatch) {
    const block = mineMatch[1].toLowerCase();
    // Map common words to block names
    const blockMap: Record<string, string> = {
      wood: '__NEAREST_LOG__', logs: '__NEAREST_LOG__', trees: '__NEAREST_LOG__', oak: 'oak_log',
      birch: 'birch_log', spruce: 'spruce_log', jungle: 'jungle_log', acacia: 'acacia_log',
      stone: 'stone', cobble: 'cobblestone', cobblestone: 'cobblestone',
      coal: 'coal_ore', iron: 'iron_ore', gold: 'gold_ore', diamond: 'diamond_ore',
      dirt: 'dirt', sand: 'sand', gravel: 'gravel',
    };
    let blockName = blockMap[block] || block;
    // Resolve environment-dependent sentinel
    if (blockName === '__NEAREST_LOG__') blockName = findNearestLogType(state);
    lastHandledChatTimestamp = latest.timestamp;
    return {
      speech: `Sure, I'll mine some ${blockName.replace('_', ' ')}!`,
      plan: {
        goal: `Mine ${blockName} for ${sender}`,
        steps: [
          { description: `Mine ${blockName}`, action: { type: 'mine' as ActionType, params: { blockName } } },
        ],
        currentStepIndex: 0,
        createdAt: now,
        failureCount: 0,
      },
    };
  }
  
  return null; // No direct command detected — fall through to LLM
}

// ── Module Implementation ────────────────────────────────────────────────────

export const CognitiveControllerModule: PianoModule = async (
  _state: Readonly<AgentState>,
  context: ModuleContext
): Promise<Partial<AgentState>> => {
  // Don't make a new decision if the agent is still executing the previous action
  if (_state.actionAwareness.isBusy) {
    return {};
  }

  // ── Auto-complete goals based on inventory/world state ──────────────────
  const goalUpdates = checkGoalCompletion(_state);
  let state: Readonly<AgentState> = _state;
  if (goalUpdates) {
    // Merge goal updates into state for the rest of this tick
    state = { ...state, goals: goalUpdates.goals! } as Readonly<AgentState>;
  }

  // Helper: merge goal updates into any return value
  const withGoals = (result: Partial<AgentState>): Partial<AgentState> =>
    goalUpdates ? { ...result, goals: goalUpdates.goals } : result;

  const plan = state.taskPlan;
  const urgency = detectUrgentInterrupt(state);

  // ── Direct player command — bypass LLM entirely for reliability ──────────
  // Check BEFORE the plan-continuation check so player commands always interrupt
  if (urgency && urgency.startsWith('CONVERSATION:')) {
    const directCmd = detectDirectCommand(state);
    if (directCmd) {
      ccLogger.info(`Direct command detected: "${directCmd.plan.goal}" — bypassing LLM`);
      const firstStep = directCmd.plan.steps[0];
      return withGoals({
        cognitiveDecision: {
          reasoning: `Player command: ${directCmd.plan.goal}`,
          action: firstStep.action,
          speech: directCmd.speech,
          timestamp: Date.now(),
        },
        taskPlan: directCmd.plan,
      });
    }
  }

  // ── If we have an active plan with remaining steps and no urgent interrupt ──
  if (plan && plan.currentStepIndex < plan.steps.length && !urgency) {
    const step = plan.steps[plan.currentStepIndex];
    ccLogger.info(`Plan "${plan.goal}" step ${plan.currentStepIndex + 1}/${plan.steps.length}: ${step.description}`);

    const cognitiveDecision: CognitiveDecision = {
      reasoning: `Following plan "${plan.goal}" — step ${plan.currentStepIndex + 1}: ${step.description}`,
      action: step.action,
      speech: null,
      timestamp: Date.now(),
    };

    return withGoals({ cognitiveDecision });
  }

  // ── Need a new plan: plan exhausted, failed, or urgent interrupt ──────────

  let planContext: string | undefined;

  if (urgency) {
    ccLogger.warn(`Urgent interrupt: ${urgency} — forcing re-plan`);
    // For conversation interrupts, include the actual chat messages so the LLM knows what was said
    if (urgency.startsWith('CONVERSATION:')) {
      const speaker = urgency.split(':')[1];
      const recentFromSpeaker = state.perception.recentChat
        .filter(c => c.sender === speaker && Date.now() - c.timestamp < 15_000)
        .map(c => `${c.sender}: "${c.message}"`)
        .join('\n');
      planContext = `URGENT — A player is talking to you!\n${recentFromSpeaker}\nRespond to what they said. If they ask you to come to them or follow them, use the "follow" action with targetName: "${speaker}". If they give you instructions, follow them. Always include speech responding to them.`;
      // Mark these messages as handled so we don't re-trigger on the same chat
      const latestMsg = state.perception.recentChat
        .filter(c => c.sender === speaker)
        .reduce((latest, c) => c.timestamp > latest ? c.timestamp : latest, 0);
      if (latestMsg > lastHandledChatTimestamp) {
        lastHandledChatTimestamp = latestMsg;
      }
    } else {
      planContext = `URGENT INTERRUPT: ${urgency}. Your previous plan has been interrupted. Address this urgency first, then resume normal goals.`;
    }
  } else if (plan && plan.failureCount >= 2) {
    planContext = `Your previous plan "${plan.goal}" failed ${plan.failureCount} times at step: "${plan.steps[plan.currentStepIndex]?.description}". Choose a different approach or simpler goal.`;
    ccLogger.warn(`Plan "${plan.goal}" failed ${plan.failureCount}x — requesting new plan`);
  } else if (plan && plan.currentStepIndex >= plan.steps.length) {
    planContext = `You just completed your plan "${plan.goal}" successfully! Decide what to do next.`;
    ccLogger.info(`Plan "${plan.goal}" completed — requesting new plan`);
  } else {
    ccLogger.info('No active plan — requesting new plan from LLM');
  }

  // ── Build system prompt ──────────────────────────────────────────────────

  // Skip LLM entirely if it's been consistently producing garbage
  if (shouldSkipLLM() && !urgency) {
    ccLogger.warn(`LLM has failed ${consecutiveLLMFailures}x in a row — using autonomous fallback`);
    // Reset counter periodically so we retry the LLM eventually (every 5th fallback)
    if (consecutiveLLMFailures % 5 === 0) {
      consecutiveLLMFailures = LLM_FAILURE_THRESHOLD; // will try LLM next cycle
    }
    return buildFallbackDecision(state);
  }

  const systemPrompt = CC_PLAN_PROMPT
    .replace('{NAME}', state.identity.name)
    .replace('{TRAITS}', state.identity.traits.join(', '))
    .replace('{COMMUNITY_GOAL}', state.identity.communityGoal)
    .replace('{MINECRAFT_RULES}', MINECRAFT_RULES);

  const stateContext = buildStateContext(state, planContext);

  // ── Call LLM for a new plan ──────────────────────────────────────────────

  try {
    const result = await context.llm.promptJSON<{
      goal: string;
      speech: string | null;
      steps: Array<{
        description: string;
        action: { type: string; params: Record<string, unknown> };
      }>;
    }>(systemPrompt, stateContext, {
      maxTokens: 2048,
      temperature: 0.7,
      model: context.agentModel,
      provider: context.agentProvider,
      host: context.agentHost,
    });

    // Validate steps — strict path first
    let validSteps: PlannedStep[] = [];
    let speechFromLLM = result.speech || null;

    if (Array.isArray(result.steps)) {
      for (const step of result.steps.slice(0, 5)) {
        if (step.action && VALID_ACTIONS.includes(step.action.type as ActionType)) {
          validSteps.push({
            description: step.description || step.action.type,
            action: {
              type: step.action.type as ActionType,
              params: step.action.params || {},
            },
          });
        }
      }
    }

    // If strict parsing found nothing, try lenient extraction
    let usedLenient = false;
    let looseGoal: string | undefined;
    if (validSteps.length === 0) {
      ccLogger.warn('Strict parsing found no valid steps — trying lenient extraction...');
      const loose = extractLooseResponse(result as unknown as Record<string, unknown>);
      if (loose) {
        validSteps = loose.steps;
        speechFromLLM = speechFromLLM || loose.speech;
        looseGoal = loose.goal;
        usedLenient = true;
        if (validSteps.length > 0) {
          ccLogger.info(`Lenient extraction recovered ${validSteps.length} step(s) from non-conforming response`);
        }
      }
    }

    // If still nothing, use fallback with speech if we got any
    if (validSteps.length === 0) {
      ccLogger.warn('LLM produced no valid steps — using fallback');
      recordLLMFailure();
      const fallback = buildFallbackDecision(state);
      if (speechFromLLM && fallback.cognitiveDecision) {
        fallback.cognitiveDecision.speech = speechFromLLM;
      }
      return withGoals(fallback);
    }

    recordLLMSuccess();

    // Resolve any environment-dependent sentinels (__NEAREST_LOG__, etc.)
    validSteps = resolveStepSentinels(validSteps, state);

    // Use the lenient goal (truncated to 100 chars) when lenient extraction was used,
    // to avoid absurdly long plan names from raw LLM narrative output.
    const rawGoal = (usedLenient && looseGoal) ? looseGoal : (result.goal || 'unnamed plan');
    const planGoal = typeof rawGoal === 'string' ? rawGoal.substring(0, 120) : 'unnamed plan';

    const newPlan: TaskPlan = {
      goal: planGoal,
      steps: validSteps,
      currentStepIndex: 0,
      createdAt: Date.now(),
      failureCount: 0,
    };

    // Log the full plan
    ccLogger.info(`New plan: "${newPlan.goal}" (${newPlan.steps.length} steps)`);
    for (let i = 0; i < newPlan.steps.length; i++) {
      ccLogger.debug(`  Step ${i + 1}: ${newPlan.steps[i].description} [${newPlan.steps[i].action.type}]`);
    }

    // Execute step 0 immediately
    const firstStep = newPlan.steps[0];
    const cognitiveDecision: CognitiveDecision = {
      reasoning: `New plan: "${newPlan.goal}" — starting step 1: ${firstStep.description}`,
      action: firstStep.action,
      speech: speechFromLLM,
      timestamp: Date.now(),
    };

    return withGoals({ cognitiveDecision, taskPlan: newPlan });
  } catch (err) {
    ccLogger.error(`LLM plan call failed: ${err instanceof Error ? err.message : String(err)}`);
    recordLLMFailure();
    return withGoals(buildFallbackDecision(state));
  }
};

// ── Fallback speech lines (rotated so agent still chats) ─────────────────────

const FALLBACK_SPEECH = [
  'Let me figure out what to do next...',
  'Time to get to work!',
  'I should gather some resources.',
  "Let's see what's around here.",
  'Better keep busy!',
  'Hmm, what should I focus on?',
  'Back to the grind!',
];

let fallbackSpeechIndex = 0;

function getFallbackSpeech(): string {
  const speech = FALLBACK_SPEECH[fallbackSpeechIndex % FALLBACK_SPEECH.length];
  fallbackSpeechIndex++;
  return speech;
}

// ── Goal auto-completion — mark goals done when inventory/world satisfies them ──

function checkGoalCompletion(state: Readonly<AgentState>): Partial<AgentState> | null {
  const inv = state.perception.inventory;
  const invSet = new Set(inv.map(i => i.name));
  const nearbyBlockNames = new Set(state.perception.nearbyBlocks.map(b => b.name));

  // Combined set: items in inventory + blocks placed nearby
  const hasItemOrBlock = (name: string) => invSet.has(name) || nearbyBlockNames.has(name);

  // Check each active goal for completion
  let changed = false;
  const updatedGoals = state.goals.currentGoals.map(g => {
    if (!g.active || g.completed) return g;

    const desc = g.description.toLowerCase();

    // "Gather wood" goals — completed if we have logs or planks
    if (desc.includes('gather wood') || desc.includes('get building materials')) {
      const hasWood = ['oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log']
        .some(l => invSet.has(l));
      const hasPlanks = ['oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks']
        .some(p => invSet.has(p));
      const totalWood = inv.filter(i => i.name.endsWith('_log') || i.name.endsWith('_planks'))
        .reduce((sum, i) => sum + i.count, 0);
      if ((hasWood || hasPlanks) && totalWood >= 10) {
        changed = true;
        ccLogger.info(`Goal auto-completed: "${g.description}" (have ${totalWood} wood items)`);
        return { ...g, completed: true };
      }
    }

    // "Craft basic tools" goals — check for crafting_table + pickaxe + axe
    if (desc.includes('craft basic tools') || desc.includes('crafting_table')) {
      const hasTable = hasItemOrBlock('crafting_table');
      const hasPick = invSet.has('wooden_pickaxe') || invSet.has('stone_pickaxe') || invSet.has('iron_pickaxe');
      const hasAxe = invSet.has('wooden_axe') || invSet.has('stone_axe') || invSet.has('iron_axe');
      // Consider done if we have a table (placed or in inv) AND a pickaxe
      if (hasTable && hasPick) {
        changed = true;
        ccLogger.info(`Goal auto-completed: "${g.description}" (have table + pickaxe)`);
        return { ...g, completed: true };
      }
    }

    // "Mine cobblestone" goals
    if (desc.includes('mine cobblestone') || desc.includes('cobblestone for')) {
      const cobbleCount = inv.find(i => i.name === 'cobblestone')?.count ?? 0;
      if (cobbleCount >= 30) { // lower threshold than 60 since some may have been used
        changed = true;
        ccLogger.info(`Goal auto-completed: "${g.description}" (have ${cobbleCount} cobblestone)`);
        return { ...g, completed: true };
      }
    }

    // Generic item-matching: check if ALL item names mentioned in the description are present
    const itemPattern = /\b(\w+_(?:pickaxe|axe|sword|shovel|hoe|table|door|chest|furnace|log|planks))\b/g;
    const mentionedItems: string[] = [];
    let match;
    while ((match = itemPattern.exec(desc)) !== null) {
      mentionedItems.push(match[1]);
    }
    if (mentionedItems.length > 0 && mentionedItems.every(item => hasItemOrBlock(item))) {
      changed = true;
      ccLogger.info(`Goal auto-completed: "${g.description}" (all mentioned items present: ${mentionedItems.join(', ')})`);
      return { ...g, completed: true };
    }

    return g;
  });

  if (!changed) return null;

  const newlyCompleted = updatedGoals.filter(g => g.completed && state.goals.currentGoals.find(og => og.id === g.id && !og.completed));
  return {
    goals: {
      currentGoals: updatedGoals,
      completedGoals: [
        ...state.goals.completedGoals.slice(-20),
        ...newlyCompleted,
      ],
    },
  };
}

// ── LLM failure tracking — skip LLM when it keeps producing garbage ──────────

let consecutiveLLMFailures = 0;
const LLM_FAILURE_THRESHOLD = 3; // After this many consecutive failures, use fallback directly

function recordLLMSuccess(): void { consecutiveLLMFailures = 0; }
function recordLLMFailure(): void { consecutiveLLMFailures++; }
function shouldSkipLLM(): boolean { return consecutiveLLMFailures >= LLM_FAILURE_THRESHOLD; }

// ── Fallback decision — full autonomous tech-tree planner ────────────────────
// When the LLM is unavailable or produces garbage, this builds a proper
// multi-step TaskPlan so the agent can make real progress without the LLM.

function buildFallbackDecision(state: Readonly<AgentState>): Partial<AgentState> {
  const steps: PlannedStep[] = [];
  const inv = state.perception.inventory;
  const invNames = inv.map(i => i.name);
  const invSet = new Set(invNames);
  const invCount = (name: string) => inv.find(i => i.name === name)?.count ?? 0;
  const hasAny = (...items: string[]) => items.some(it => invSet.has(it));

  const logType = findNearestLogType(state);
  const planksType = findMatchingPlanks(state);

  const hasLogs = ALL_LOG_TYPES.some(l => invSet.has(l));
  const totalLogs = ALL_LOG_TYPES.reduce((sum, l) => sum + invCount(l), 0);
  const hasPlanks = ALL_PLANKS_TYPES.some(p => invSet.has(p));
  const totalPlanks = ALL_PLANKS_TYPES.reduce((sum, p) => sum + invCount(p), 0);
  const hasSticks = invSet.has('stick');
  const stickCount = invCount('stick');
  // Check both inventory AND nearby placed blocks for crafting_table
  const nearbyBlockSet = new Set(state.perception.nearbyBlocks.map(b => b.name));
  const hasTable = invSet.has('crafting_table') || nearbyBlockSet.has('crafting_table');
  const hasPick1 = invSet.has('wooden_pickaxe');
  const hasPick2 = hasAny('stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe');
  const hasCobble = invSet.has('cobblestone');
  const cobbleCount = invCount('cobblestone');
  const hasCoal = invSet.has('coal');
  const hasIronOre = hasAny('iron_ore', 'deepslate_iron_ore', 'raw_iron');
  const hasFurnace = invSet.has('furnace') || nearbyBlockSet.has('furnace');
  const hasIronIngot = invSet.has('iron_ingot');
  const hasPick3 = hasAny('iron_pickaxe', 'diamond_pickaxe');

  let goal = 'Tech tree progression';
  let speech = getFallbackSpeech();

  // ── Eat if hungry ──
  if (state.perception.food < 10) {
    return {
      cognitiveDecision: {
        reasoning: 'Hungry — eating first.',
        action: { type: 'eat', params: {} },
        speech: "I'm getting hungry, better eat something!",
        timestamp: Date.now(),
      },
      taskPlan: null,
    };
  }

  // ── Phase 1: Get enough wood (need at least 4 logs for planks→table→sticks→pickaxe) ──
  if (!hasLogs && !hasPlanks && !hasTable) {
    // Check if any logs are actually visible in perception — if not, explore first
    const logsVisible = state.perception.nearbyBlocks.some(b => b.name.endsWith('_log'));
    if (!logsVisible) {
      goal = 'Find trees — no logs visible nearby';
      speech = 'I need to find some trees first.';
      steps.push({ description: 'Explore to find trees', action: { type: 'explore', params: {} } });
      steps.push({ description: 'Explore further for wood', action: { type: 'explore', params: {} } });
    } else {
      goal = `Gather ${logType.replace('_', ' ')} for crafting`;
      speech = 'Let me start by gathering some wood.';
    }
    // Mine multiple logs in one plan
    steps.push({ description: `Mine ${logType}`, action: { type: 'mine', params: { blockName: logType } } });
    steps.push({ description: `Mine more ${logType}`, action: { type: 'mine', params: { blockName: logType } } });
    steps.push({ description: `Mine more ${logType}`, action: { type: 'mine', params: { blockName: logType } } });
  }
  // ── Phase 2: Craft planks if we have logs but not enough planks ──
  else if (hasLogs && totalPlanks < 4 && !hasTable) {
    goal = 'Craft planks and crafting table';
    speech = 'Time to craft some planks and get a crafting table set up!';
    // Craft planks multiple times to get 8+ planks (enough for table + sticks)
    steps.push({ description: `Craft ${planksType}`, action: { type: 'craft', params: { itemName: planksType, count: 1 } } });
    steps.push({ description: `Craft more ${planksType}`, action: { type: 'craft', params: { itemName: planksType, count: 1 } } });
    steps.push({ description: 'Craft crafting_table', action: { type: 'craft', params: { itemName: 'crafting_table', count: 1 } } });
    steps.push({ description: 'Place crafting_table', action: { type: 'place', params: { blockName: 'crafting_table' } } });
    steps.push({ description: 'Craft sticks', action: { type: 'craft', params: { itemName: 'stick', count: 1 } } });
  }
  // ── Phase 3: Have planks, make crafting table ──
  else if (hasPlanks && !hasTable) {
    goal = 'Set up crafting table and make tools';
    speech = 'Got planks, time for a crafting table!';
    if (totalPlanks < 4) {
      steps.push({ description: `Craft ${planksType}`, action: { type: 'craft', params: { itemName: planksType, count: 1 } } });
    }
    steps.push({ description: 'Craft crafting_table', action: { type: 'craft', params: { itemName: 'crafting_table', count: 1 } } });
    steps.push({ description: 'Place crafting_table', action: { type: 'place', params: { blockName: 'crafting_table' } } });
    if (stickCount < 2) {
      steps.push({ description: 'Craft sticks', action: { type: 'craft', params: { itemName: 'stick', count: 1 } } });
    }
    steps.push({ description: 'Craft wooden_pickaxe', action: { type: 'craft', params: { itemName: 'wooden_pickaxe', count: 1 } } });
  }
  // ── Phase 4: Have table, make wooden pickaxe ──
  else if (hasTable && !hasPick1 && !hasPick2) {
    goal = 'Craft a wooden pickaxe';
    speech = 'Let me craft a pickaxe so I can mine stone!';
    if (totalPlanks < 3) {
      steps.push({ description: `Craft ${planksType}`, action: { type: 'craft', params: { itemName: planksType, count: 1 } } });
    }
    if (stickCount < 2) {
      steps.push({ description: 'Craft sticks', action: { type: 'craft', params: { itemName: 'stick', count: 1 } } });
    }
    steps.push({ description: 'Craft wooden_pickaxe', action: { type: 'craft', params: { itemName: 'wooden_pickaxe', count: 1 } } });
  }
  // ── Phase 5: Have wooden pickaxe — mine stone, upgrade to stone pickaxe ──
  else if (hasPick1 && !hasPick2) {
    goal = 'Mine stone and craft stone pickaxe';
    speech = 'Time to upgrade to a stone pickaxe!';
    if (cobbleCount < 3) {
      steps.push({ description: 'Mine stone', action: { type: 'mine', params: { blockName: 'stone' } } });
      steps.push({ description: 'Mine more stone', action: { type: 'mine', params: { blockName: 'stone' } } });
      steps.push({ description: 'Mine more stone', action: { type: 'mine', params: { blockName: 'stone' } } });
    }
    if (stickCount < 2) {
      steps.push({ description: 'Craft sticks', action: { type: 'craft', params: { itemName: 'stick', count: 1 } } });
    }
    steps.push({ description: 'Craft stone_pickaxe', action: { type: 'craft', params: { itemName: 'stone_pickaxe', count: 1 } } });
  }
  // ── Phase 6: Have stone pickaxe — mine iron ──
  else if (hasPick2 && !hasIronIngot && !hasIronOre) {
    goal = 'Mine coal and iron ore';
    speech = 'Looking for iron and coal underground!';
    if (!hasCoal) {
      steps.push({ description: 'Mine coal ore', action: { type: 'mine', params: { blockName: 'coal_ore' } } });
    }
    steps.push({ description: 'Mine iron ore', action: { type: 'mine', params: { blockName: 'iron_ore' } } });
    steps.push({ description: 'Mine more iron ore', action: { type: 'mine', params: { blockName: 'iron_ore' } } });
  }
  // ── Phase 7: Have iron ore — smelt it ──
  else if (hasIronOre && !hasIronIngot) {
    goal = 'Smelt iron ore';
    speech = 'Time to smelt some iron!';
    if (!hasFurnace) {
      if (cobbleCount < 8) {
        steps.push({ description: 'Mine stone for furnace', action: { type: 'mine', params: { blockName: 'stone' } } });
        steps.push({ description: 'Mine more stone', action: { type: 'mine', params: { blockName: 'stone' } } });
      }
      steps.push({ description: 'Craft furnace', action: { type: 'craft', params: { itemName: 'furnace', count: 1 } } });
      steps.push({ description: 'Place furnace', action: { type: 'place', params: { blockName: 'furnace' } } });
    }
    steps.push({ description: 'Smelt iron ore', action: { type: 'smelt', params: { itemName: 'iron_ore', count: 1 } } });
  }
  // ── Phase 8: Have iron — craft iron pickaxe ──
  else if (hasIronIngot && !hasPick3) {
    goal = 'Craft iron pickaxe';
    speech = 'Iron pickaxe time!';
    if (stickCount < 2) {
      steps.push({ description: 'Craft sticks', action: { type: 'craft', params: { itemName: 'stick', count: 1 } } });
    }
    steps.push({ description: 'Craft iron_pickaxe', action: { type: 'craft', params: { itemName: 'iron_pickaxe', count: 1 } } });
  }
  // ── Endgame: explore and gather more resources ──
  else {
    goal = 'Explore and gather resources';
    speech = getFallbackSpeech();
    steps.push({ description: 'Explore the area', action: { type: 'explore', params: {} } });
    // Mine more useful resources
    if (hasPick2) {
      steps.push({ description: 'Mine iron ore', action: { type: 'mine', params: { blockName: 'iron_ore' } } });
    } else if (hasPick1) {
      steps.push({ description: 'Mine stone', action: { type: 'mine', params: { blockName: 'stone' } } });
      steps.push({ description: 'Mine coal ore', action: { type: 'mine', params: { blockName: 'coal_ore' } } });
    }
  }

  // Safety: if steps are still empty, mine logs
  if (steps.length === 0) {
    steps.push({ description: `Mine ${logType}`, action: { type: 'mine', params: { blockName: logType } } });
  }

  const plan: TaskPlan = {
    goal,
    steps,
    currentStepIndex: 0,
    createdAt: Date.now(),
    failureCount: 0,
  };

  ccLogger.info(`Fallback plan: "${goal}" (${steps.length} steps)`);

  return {
    cognitiveDecision: {
      reasoning: `Fallback tech tree: ${goal}`,
      action: steps[0].action,
      speech,
      timestamp: Date.now(),
    },
    taskPlan: plan,
  };
}
