/**
 * CognitiveController — The bottleneck decision-maker.
 *
 * This is the core of the PIANO architecture's coherence mechanism. It:
 * 1. Reads a compressed summary of the full agent state (information bottleneck)
 * 2. Makes a single LLM call to produce a high-level decision
 * 3. Broadcasts that decision to all downstream modules (action + speech)
 *
 * Inspired by Global Workspace Theory / theories of consciousness —
 * the CC ensures that what the agent says and does are aligned.
 *
 * Runs every ~2-3 seconds.
 */

import { AgentState, CognitiveDecision, ActionIntent, ActionType } from '../agent/AgentState';
import { PianoModule, ModuleContext } from '../agent/ModuleRunner';
import { summarizePerception, getProgressionStatus } from './PerceptionModule';
import { summarizeSocial } from './SocialAwarenessModule';
import { summarizeGoals } from './GoalGenerationModule';
import { Logger } from '../utils/Logger';

// ── Minecraft game rules injected into every decision ───────────────────

const MINECRAFT_RULES = `
MINECRAFT SURVIVAL RULES (follow these exactly):
1. Bare hands can break: leaves, grass, dirt, sand, gravel, oak_log/wood logs. No tool needed.
2. You CANNOT get drops from stone, coal_ore, iron_ore or any ore without a pickaxe. Attempting it wastes time.
3. TECH TREE (must follow in order):
   → Punch oak_log (bare hands) → craft oak_planks (4 per log, no table) → craft sticks (2 planks = 4 sticks)
   → craft crafting_table (4 planks, no table) → place crafting_table nearby
   → craft wooden_pickaxe (3 planks + 2 sticks at table) → mine stone/coal_ore
   → craft stone_pickaxe (3 cobblestone + 2 sticks at table) → mine iron_ore
   → smelt iron_ore in furnace → craft iron_pickaxe → mine gold/diamond
4. CRAFTING RECIPES:
   - oak_planks: 1 oak_log → 4 planks (no table)
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

SPATIAL AWARENESS — where things exist in the Minecraft world:
- TREES (oak_log, birch_log, etc.) grow on the SURFACE. Y ≈ 60-80. Go UP or stay on surface level to find them.
- STONE is found just below the surface, starting at Y ≈ 55-60. Dig DOWN a few blocks from surface.
- COAL ORE spawns at Y = 0-128, most common around Y = 48-96. Found in stone layers.
- IRON ORE spawns at Y = -64 to 72, most common around Y = 16. Look inside caves or dig down.
- GOLD ORE spawns at Y = -64 to 32, most common around Y = -16 (deep underground).
- DIAMOND ORE spawns at Y = -64 to 16, most common around Y = -59 (very deep).
- If you need wood but see no oak_log nearby, explore on the SURFACE (move, keeping Y ≈ 64) — do NOT dig down.
- If you need ores, look for caves at your current Y level or dig down.
- Pay attention to the Y coordinate in your position and nearby block positions.

ACTION-SPEECH COHERENCE:
- Your speech MUST match your action. If you say "I'll mine wood", your action MUST be mine oak_log.
- Do NOT say you will do something in your speech and then choose a different action.
- If your action is craft, say you're crafting. If exploring, say you're exploring. No contradictions.
- Prefer short, useful speech. Don't narrate what you can't actually do.`;

// ── Prompt ───────────────────────────────────────────────────────────────────

const CC_SYSTEM_PROMPT = `You are the decision-making core of {NAME}, a Minecraft agent.
Your traits: {TRAITS}
Community goal: {COMMUNITY_GOAL}
{MINECRAFT_RULES}

You receive a summary of your current state and must make ONE decision about what to do RIGHT NOW.
Your decision must be coherent — what you do and what you say should align.

Available actions:
- mine: Mine a specific block (params: blockName)
- craft: Craft an item (params: itemName, count)
- place: Place a block (params: blockName)
- move: Move to a location (params: x, y, z) or toward a nearby entity
- follow: Follow an agent (params: targetName)
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
- You MUST always choose an action — use idle only if you are genuinely waiting.
- Only choose actions you can actually perform given your inventory and surroundings.
- If someone is talking to you, consider responding before doing other things.
- If your health is low, prioritize survival (eat first, then flee).
- Work toward your highest-priority goal every turn; do not stay idle unnecessarily.
- Be true to your personality traits.
- You can speak AND act, or just act, or just speak — but action must never be null.

Respond with ONLY a valid JSON object (no markdown, no extra text):
{
  "reasoning": "<brief explanation of your thought process>",
  "action": {
    "type": "<action type>",
    "params": { <action-specific parameters> }
  },
  "speech": "<what to say aloud>" or null
}`;

// ── Module Implementation ────────────────────────────────────────────────────

export const CognitiveControllerModule: PianoModule = async (
  state: Readonly<AgentState>,
  context: ModuleContext
): Promise<Partial<AgentState>> => {
  // Don't make a new decision if the agent is still executing the previous action
  if (state.actionAwareness.isBusy) {
    return {};
  }

  // ── Build compressed state summary (information bottleneck) ──────────────

  const perception = summarizePerception(state.perception);
  const progression = getProgressionStatus(state.perception.inventory);
  const social = summarizeSocial(state.social);
  const goals = summarizeGoals(state.goals);

  // Working memory summary
  const wm = state.memory.workingMemory.join('\n');

  // Recent action results
  const recentActions = state.actionAwareness.recentResults
    .slice(-3)
    .map(r => `${r.action.type}: ${r.success ? '✓' : '✗'} ${r.outcome}`)
    .join('\n') || 'No recent actions.';

  // Active social goals
  const socialGoals = state.social.socialGoals
    .filter(g => g.active)
    .map(g => `- ${g.description}`)
    .join('\n') || 'None';

  // Compress into a single context string (~500 tokens target)
  const stateContext = `== Perception ==
${perception}

== Progression ==
${progression}

== Goals (by priority) ==
${goals}

== Social ==
${social}

== Social Goals ==
${socialGoals}

== Recent Actions ==
${recentActions}

== Key Memories ==
${state.memory.shortTermMemory.slice(-5).map(m => `- ${m.content}`).join('\n') || 'None'}`;

  // ── Build system prompt ──────────────────────────────────────────────────

  const systemPrompt = CC_SYSTEM_PROMPT
    .replace('{NAME}', state.identity.name)
    .replace('{TRAITS}', state.identity.traits.join(', '))
    .replace('{COMMUNITY_GOAL}', state.identity.communityGoal)
    .replace('{MINECRAFT_RULES}', MINECRAFT_RULES);

  // ── Make the decision ────────────────────────────────────────────

  try {
    const result = await context.llm.promptJSON<{
      reasoning: string;
      action: { type: string; params: Record<string, unknown> } | null;
      speech: string | null;
    }>(systemPrompt, stateContext, {
      maxTokens: 2048,
      temperature: 0.7,
    });

    // Log the decision for observability
    const actionStr = result.action ? `${result.action.type}(${JSON.stringify(result.action.params).substring(0, 60)})` : 'none';
    const ccLogger = new Logger(`CC:${state.identity.name}`);
    ccLogger.info(`Decision: ${actionStr} | ${result.reasoning?.substring(0, 80) || 'no reasoning'}${result.speech ? ` | says: "${result.speech.substring(0, 40)}"` : ''}`);

    // Validate action type
    const validActions: ActionType[] = [
      'mine', 'craft', 'place', 'move', 'follow', 'attack', 'eat',
      'deposit', 'withdraw', 'equip', 'idle', 'explore', 'smelt',
      'trade', 'build', 'custom',
    ];

    let action: ActionIntent | null = null;
    if (result.action && validActions.includes(result.action.type as ActionType)) {
      action = {
        type: result.action.type as ActionType,
        params: result.action.params || {},
      };
    }

    // Post-validate: if action is null (LLM didn't produce one), fallback to next logical step
    if (!action) {
      const progression = getProgressionStatus(state.perception.inventory);
      const tierMatch = progression.match(/Tech tier: (\d+)/);
      const tier = tierMatch ? parseInt(tierMatch[1]) : 0;
      if (tier < 1) {
        action = { type: 'mine', params: { blockName: 'oak_log', count: 3 } };
      } else if (tier < 3) {
        // Has wood but no pickaxe — craft next item in chain
        const inv = state.perception.inventory.map(i => i.name);
        if (!inv.includes('oak_planks') && !inv.includes('spruce_planks') && !inv.includes('birch_planks')) {
          action = { type: 'craft', params: { itemName: 'oak_planks', count: 1 } };
        } else if (!inv.includes('crafting_table')) {
          action = { type: 'craft', params: { itemName: 'crafting_table', count: 1 } };
        } else if (!inv.includes('stick')) {
          action = { type: 'craft', params: { itemName: 'stick', count: 1 } };
        } else {
          action = { type: 'craft', params: { itemName: 'wooden_pickaxe', count: 1 } };
        }
      } else {
        action = { type: 'explore', params: {} };
      }
    }

    const cognitiveDecision: CognitiveDecision = {
      reasoning: result.reasoning || 'No reasoning provided.',
      action,
      speech: result.speech || null,
      timestamp: Date.now(),
    };

    return { cognitiveDecision };
  } catch {
    // On LLM failure, pick a useful fallback action instead of idling
    const fallbackActions: ActionIntent[] = [
      { type: 'explore', params: {} },
      { type: 'explore', params: {} },
      { type: 'explore', params: {} },
      { type: 'mine', params: { blockName: 'oak_log', count: 3 } },
      { type: 'mine', params: { blockName: 'stone', count: 5 } },
    ];
    const fallback = fallbackActions[Math.floor(Math.random() * fallbackActions.length)];

    // Eat if hungry
    const effectiveAction = state.perception.food < 10
      ? { type: 'eat' as ActionType, params: {} }
      : fallback;

    return {
      cognitiveDecision: {
        reasoning: 'LLM unavailable — exploring autonomously.',
        action: effectiveAction,
        speech: null,
        timestamp: Date.now(),
      },
    };
  }
};
