/**
 * GoalGenerationModule — Creates and prioritizes goals from experiences,
 * social context, community objectives, and environmental observations.
 * Runs every ~10-30 seconds (slow, deliberative module).
 *
 * Goals are categorized: survival, social, economic, civic, exploration, religious.
 * The module uses LLM reasoning over the agent's state to generate goals
 * recursively — interactions spawn new goals, which spawn new interactions.
 */

import { AgentState, AgentGoals, Goal, GoalCategory } from '../agent/AgentState';
import { PianoModule, ModuleContext } from '../agent/ModuleRunner';
import { summarizePerception, getProgressionStatus } from './PerceptionModule';
import { summarizeSocial } from './SocialAwarenessModule';
import { v4 as uuidv4 } from 'uuid';

// ── Prompt ───────────────────────────────────────────────────────────────────

const GOAL_GENERATION_PROMPT = `You are {NAME}, a Minecraft agent in a community simulation.

Your traits: {TRAITS}
Your backstory: {BACKSTORY}
Community goal: {COMMUNITY_GOAL}

== Current Situation ==
{PERCEPTION}

== Social Context ==
{SOCIAL}

== Current Goals ==
{CURRENT_GOALS}

== Recent Memories ==
{MEMORIES}

== Location Knowledge ==
{LOCATIONS}

Based on your personality, situation, and community needs, generate 2-5 goals you should pursue.
Consider all categories: survival (food, shelter, tools), social (relationships, cooperation),
economic (gathering, crafting, trading), civic (rules, governance, community projects),
exploration (discovering new areas), and religious/cultural (beliefs, traditions).

IMPORTANT — Minecraft tech-tree constraints:
- Your current tech tier and next steps are shown in the Progression section.
- Only generate goals that are achievable given your current tools and resources.
- If tech tier is 0-2, your FIRST survival goal must always be wood → crafting_table → wooden_pickaxe.
- Do NOT generate goals like "mine iron_ore" if you don’t have a stone_pickaxe yet.
- goal steps should reference actual Minecraft item names. For wood, use whatever log type is visible nearby (oak_log, birch_log, spruce_log, etc.) — don't always default to oak.

Respond with ONLY a JSON object:
{
  "goals": [
    {
      "category": "<survival|social|economic|civic|exploration|religious>",
      "description": "<specific, actionable goal>",
      "priority": <1-10>,
      "steps": ["<step1>", "<step2>"]
    }
  ]
}`;

// ── Module Implementation ────────────────────────────────────────────────────

export const GoalGenerationModule: PianoModule = async (
  state: Readonly<AgentState>,
  context: ModuleContext
): Promise<Partial<AgentState>> => {
  // Gather context for the LLM
  const perception = summarizePerception(state.perception);
  const progression = getProgressionStatus(state.perception.inventory, state.perception.nearbyBlocks);
  const social = summarizeSocial(state.social);

  const currentGoals = state.goals.currentGoals
    .filter(g => g.active && !g.completed)
    .map(g => `- [${g.category}] ${g.description} (priority: ${g.priority})`)
    .join('\n') || 'No active goals.';

  const memories = state.memory.shortTermMemory
    .slice(-10)
    .map(m => `- ${m.content}`)
    .join('\n') || 'No recent memories.';

  const locations = state.locationMemories
    .slice(-5)
    .map(l => `- ${l.description} at (${Math.round(l.position.x)}, ${Math.round(l.position.y)}, ${Math.round(l.position.z)})`)
    .join('\n') || 'No known locations.';

  const prompt = GOAL_GENERATION_PROMPT
    .replace('{NAME}', state.identity.name)
    .replace('{TRAITS}', state.identity.traits.join(', '))
    .replace('{BACKSTORY}', state.identity.backstory || 'A member of the community.')
    .replace('{COMMUNITY_GOAL}', state.identity.communityGoal)
    .replace('{PERCEPTION}', perception + '\n\n== Progression ==\n' + progression)
    .replace('{SOCIAL}', social)
    .replace('{CURRENT_GOALS}', currentGoals)
    .replace('{MEMORIES}', memories)
    .replace('{LOCATIONS}', locations);

  try {
    const result = await context.llm.promptJSON<{
      goals: Array<{
        category: string;
        description: string;
        priority: number;
        steps?: string[];
      }>;
    }>(
      'You are an AI goal generation system. Respond with valid JSON only.',
      prompt,
      { maxTokens: 1024, temperature: 0.8, model: context.agentModel, provider: context.agentProvider, host: context.agentHost }
    );

    // Mark old goals as inactive
    const updatedCurrentGoals = state.goals.currentGoals.map(g => ({
      ...g,
      active: false,
    }));

    // Move completed goals
    const newlyCompleted = updatedCurrentGoals.filter(g => g.completed);
    const previouslyCompleted = state.goals.completedGoals.slice(-20); // Keep last 20

    // Create new goals
    const validCategories: GoalCategory[] = ['survival', 'social', 'economic', 'civic', 'exploration', 'religious'];
    const newGoals: Goal[] = (result.goals || []).map(g => ({
      id: uuidv4(),
      category: (validCategories.includes(g.category as GoalCategory)
        ? g.category : 'survival') as GoalCategory,
      description: g.description,
      priority: Math.max(1, Math.min(10, g.priority)),
      steps: g.steps,
      completed: false,
      active: true,
      createdAt: Date.now(),
    }));

    // Sort by priority
    newGoals.sort((a, b) => b.priority - a.priority);

    const goals: AgentGoals = {
      currentGoals: newGoals,
      completedGoals: [...previouslyCompleted, ...newlyCompleted].slice(-20),
    };

    return { goals };
  } catch {
    // Keep existing goals on failure
    return {};
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Summarize goals for the Cognitive Controller.
 */
export function summarizeGoals(goals: AgentGoals): string {
  const active = goals.currentGoals.filter(g => g.active && !g.completed);
  if (active.length === 0) return 'No active goals.';

  return active
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5)
    .map(g => {
      const steps = g.steps ? ` Steps: ${g.steps.join(' → ')}` : '';
      return `[${g.category}] ${g.description} (priority: ${g.priority})${steps}`;
    })
    .join('\n');
}
