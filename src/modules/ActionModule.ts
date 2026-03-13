/**
 * ActionModule — Translates CognitiveController decisions into Mineflayer
 * commands. Tracks action outcomes for the ActionAwareness feedback loop.
 * Advances the TaskPlan on success, increments failure count on failure,
 * and clears the plan after repeated failures.
 *
 * Uses a skill library of predefined functions wrapping Mineflayer APIs.
 * Runs every ~1-2 seconds.
 */

import { AgentState, ActionAwareness, ActionIntent, ActionResult, ActionType, TaskPlan } from '../agent/AgentState';
import { PianoModule, ModuleContext } from '../agent/ModuleRunner';
import { Skills } from '../skills/Skills';
import { Logger } from '../utils/Logger';

const MAX_RECENT_RESULTS = 20;
const ACTION_TIMEOUT_MS = 30_000; // 30s timeout for any action
const MAX_STEP_FAILURES = 2;      // clear plan after this many consecutive failures

/** Patterns that indicate a skill returned a failure message instead of throwing. */
const FAILURE_PATTERNS = /^(Could not find|CANNOT |Cannot craft|No recipe found|Unknown item|Don't have|No (?:chest|furnace|food|block surface|building material)|Failed to|No food in inventory|No building materials)/i;

// ── Module Factory ───────────────────────────────────────────────────────────

export function createActionModule(): PianoModule {
  const logger = new Logger('ActionModule');
  let lastProcessedDecisionTs = 0;

  return async (
    state: Readonly<AgentState>,
    context: ModuleContext
  ): Promise<Partial<AgentState>> => {
    const { cognitiveDecision, actionAwareness, taskPlan } = state;

    // If busy, check if action timed out
    if (actionAwareness.isBusy && actionAwareness.busySince) {
      if (Date.now() - actionAwareness.busySince > ACTION_TIMEOUT_MS) {
        logger.warn(`Action timed out after ${ACTION_TIMEOUT_MS}ms`);
        // Timeout counts as a failure — update plan
        const updatedPlan = handleStepFailure(taskPlan, 'Action timed out', logger);
        return {
          actionAwareness: {
            ...actionAwareness,
            isBusy: false,
            busySince: null,
            lastResult: {
              action: cognitiveDecision.action || { type: 'idle', params: {} },
              success: false,
              outcome: 'Action timed out',
              timestamp: Date.now(),
              durationMs: Date.now() - actionAwareness.busySince,
            },
            recentResults: [...actionAwareness.recentResults].slice(-MAX_RECENT_RESULTS),
          },
          taskPlan: updatedPlan,
        };
      }
      // Still executing, don't start new action
      return {};
    }

    // ── DROWNING OVERRIDE — highest priority survival action ────────────
    const isInWater = state.perception.isInWater;
    const oxygenLevel = state.perception.oxygenLevel;
    if (isInWater && oxygenLevel < 200) {
      logger.warn(`DROWNING OVERRIDE — oxygen ${oxygenLevel}/300, forcing swim to surface`);
      const swimAction: ActionIntent = { type: 'custom' as ActionType, params: { skill: 'swimToSurface' } };
      const startTime = Date.now();
      try {
        const skills = new Skills(context.bot);
        const outcome = await skills.swimToSurface();
        const result: ActionResult = { action: swimAction, success: true, outcome, timestamp: Date.now(), durationMs: Date.now() - startTime };
        return {
          actionAwareness: {
            ...actionAwareness,
            isBusy: false,
            busySince: null,
            lastResult: result,
            recentResults: [...actionAwareness.recentResults, result].slice(-MAX_RECENT_RESULTS),
          },
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const result: ActionResult = { action: swimAction, success: false, outcome: errMsg, timestamp: Date.now(), durationMs: Date.now() - startTime };
        return {
          actionAwareness: {
            ...actionAwareness,
            isBusy: false,
            busySince: null,
            lastResult: result,
            recentResults: [...actionAwareness.recentResults, result].slice(-MAX_RECENT_RESULTS),
          },
        };
      }
    }

    const action = cognitiveDecision.action;
    if (!action) return {};

    // Don't re-execute a decision we already processed
    if (cognitiveDecision.timestamp <= lastProcessedDecisionTs) {
      return {};
    }
    lastProcessedDecisionTs = cognitiveDecision.timestamp;

    if (taskPlan) {
      logger.info(`Executing plan "${taskPlan.goal}" step ${taskPlan.currentStepIndex + 1}/${taskPlan.steps.length}: ${action.type} (${JSON.stringify(action.params).substring(0, 80)})`);
    } else {
      logger.info(`Executing action: ${action.type} (params: ${JSON.stringify(action.params).substring(0, 80)})`);
    }

    // ── Execute the action ─────────────────────────────────────────────────

    const awareness: ActionAwareness = {
      lastResult: actionAwareness.lastResult,
      recentResults: [...actionAwareness.recentResults],
      isBusy: true,
      busySince: Date.now(),
    };

    const startTime = Date.now();
    let updatedPlan = taskPlan;

    try {
      const outcome = await executeAction(action, context);

      // Skills return descriptive failure strings instead of throwing.
      // Detect these and promote them to errors so the plan doesn't
      // silently advance past actions that never actually happened.
      if (FAILURE_PATTERNS.test(outcome)) {
        throw new Error(outcome);
      }

      const result: ActionResult = {
        action,
        success: true,
        outcome,
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
      };

      awareness.lastResult = result;
      awareness.recentResults.push(result);
      awareness.isBusy = false;
      awareness.busySince = null;

      // ── Advance plan on success ─────────────────────────────────────
      updatedPlan = handleStepSuccess(taskPlan, logger);

      logger.debug(`Action ${action.type} succeeded: ${outcome}`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      const result: ActionResult = {
        action,
        success: false,
        outcome: errMsg,
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
      };

      awareness.lastResult = result;
      awareness.recentResults.push(result);
      awareness.isBusy = false;
      awareness.busySince = null;

      // ── Handle plan failure ─────────────────────────────────────────
      updatedPlan = handleStepFailure(taskPlan, errMsg, logger);

      logger.debug(`Action ${action.type} failed: ${errMsg}`);
    }

    // Trim recent results
    if (awareness.recentResults.length > MAX_RECENT_RESULTS) {
      awareness.recentResults = awareness.recentResults.slice(-MAX_RECENT_RESULTS);
    }

    return { actionAwareness: awareness, taskPlan: updatedPlan };
  };
}

// ── Plan advancement helpers ─────────────────────────────────────────────────

function handleStepSuccess(plan: TaskPlan | null, logger: Logger): TaskPlan | null {
  if (!plan) return null;

  const nextIndex = plan.currentStepIndex + 1;
  if (nextIndex >= plan.steps.length) {
    logger.info(`Plan "${plan.goal}" COMPLETED (all ${plan.steps.length} steps done)`);
    return null; // Plan exhausted — CC will create a new one
  }

  logger.info(`Plan "${plan.goal}" advancing to step ${nextIndex + 1}/${plan.steps.length}: ${plan.steps[nextIndex].description}`);
  return {
    ...plan,
    currentStepIndex: nextIndex,
    failureCount: 0, // reset failure count on successful step
  };
}

function handleStepFailure(plan: TaskPlan | null, reason: string, logger: Logger): TaskPlan | null {
  if (!plan) return null;

  const currentStep = plan.steps[plan.currentStepIndex];
  const newFailureCount = plan.failureCount + 1;

  // If a mine step failed because the resource wasn't nearby, inject an
  // explore step before it so the agent goes looking instead of re-planning
  if (
    currentStep &&
    currentStep.action.type === 'mine' &&
    newFailureCount === 1 &&
    /could not find|no nearby|not found|cannot find/i.test(reason)
  ) {
    const blockName = currentStep.action.params.blockName ?? 'resources';
    logger.info(
      `Plan "${plan.goal}" step ${plan.currentStepIndex + 1} can't find ${blockName} — inserting explore step`
    );
    const exploreStep = {
      description: `Explore to find ${blockName}`,
      action: { type: 'explore' as const, params: {} },
    };
    // Insert the explore step at the current index, pushing the failed mine step forward
    const newSteps = [...plan.steps];
    newSteps.splice(plan.currentStepIndex, 0, exploreStep);
    return {
      ...plan,
      steps: newSteps,
      failureCount: 0, // reset — the explore step is new
    };
  }

  if (newFailureCount >= MAX_STEP_FAILURES) {
    logger.warn(`Plan "${plan.goal}" ABANDONED after ${newFailureCount} failures at step ${plan.currentStepIndex + 1}: ${reason}`);
    return null; // Clear plan — CC will re-plan with failure context
  }

  logger.warn(`Plan "${plan.goal}" step ${plan.currentStepIndex + 1} failed (${newFailureCount}/${MAX_STEP_FAILURES}): ${reason}`);
  return {
    ...plan,
    failureCount: newFailureCount,
  };
}

// ── Action Dispatcher ────────────────────────────────────────────────────────

async function executeAction(action: ActionIntent, context: ModuleContext): Promise<string> {
  const { bot } = context;
  const skills = new Skills(bot);
  const p = action.params;

  switch (action.type) {
    case 'mine':
      return skills.mineBlock(p.blockName as string, p.count as number | undefined);

    case 'craft':
      return skills.craftItem(p.itemName as string, p.count as number | undefined);

    case 'place':
      return skills.placeBlock(p.blockName as string);

    case 'move': {
      const params = p as Record<string, unknown>;
      const dest = params.destination as Record<string, number> | undefined;
      const x = (params.x as number) ?? dest?.x;
      const y = (params.y as number) ?? dest?.y;
      const z = (params.z as number) ?? dest?.z;
      if (x !== undefined && y !== undefined && z !== undefined) {
        return skills.moveTo(x, y, z);
      }
      // Move toward named entity
      if (p.targetName || p.target) {
        return skills.moveToEntity(p.targetName as string || p.target as string);
      }
      return 'No valid destination specified';
    }

    case 'follow':
      return skills.followEntity(p.targetName as string);

    case 'attack':
      return skills.attackEntity(p.targetName as string);

    case 'eat':
      return skills.eat();

    case 'deposit':
      return skills.depositToChest(p.itemName as string, p.count as number);

    case 'withdraw':
      return skills.withdrawFromChest(p.itemName as string, p.count as number);

    case 'equip':
      return skills.equipItem(p.itemName as string);

    case 'explore':
      return skills.explore(p.direction as string | undefined);

    case 'smelt':
      return skills.smeltItem(p.itemName as string, p.count as number | undefined);

    case 'idle':
      // Wait a moment
      await new Promise(r => setTimeout(r, 2000));
      return 'Idled for 2 seconds';

    case 'trade':
      // Trade is social — handled via chat
      return `Proposed trade to ${p.targetAgent}: offering ${p.offer} for ${p.request}`;

    case 'build':
      return skills.buildStructure(p.description as string);

    default:
      return `Unknown action type: ${action.type}`;
  }
}

// Export for direct usage
export const ActionModule = createActionModule();
