/**
 * ActionModule — Translates CognitiveController decisions into Mineflayer
 * commands. Tracks action outcomes for the ActionAwareness feedback loop.
 * Runs every ~1-2 seconds.
 *
 * Uses a skill library of predefined functions wrapping Mineflayer APIs.
 */

import { AgentState, ActionAwareness, ActionIntent, ActionResult } from '../agent/AgentState';
import { PianoModule, ModuleContext } from '../agent/ModuleRunner';
import { Skills } from '../skills/Skills';
import { Logger } from '../utils/Logger';

const MAX_RECENT_RESULTS = 20;
const ACTION_TIMEOUT_MS = 30_000; // 30s timeout for any action

// ── Module Factory ───────────────────────────────────────────────────────────

export function createActionModule(): PianoModule {
  const logger = new Logger('ActionModule');
  let currentAction: Promise<string> | null = null;
  let actionStartTime = 0;
  let lastProcessedDecisionTs = 0;

  return async (
    state: Readonly<AgentState>,
    context: ModuleContext
  ): Promise<Partial<AgentState>> => {
    const { cognitiveDecision, actionAwareness } = state;

    // If busy, check if action timed out
    if (actionAwareness.isBusy && actionAwareness.busySince) {
      if (Date.now() - actionAwareness.busySince > ACTION_TIMEOUT_MS) {
        logger.warn(`Action timed out after ${ACTION_TIMEOUT_MS}ms`);
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
        };
      }
      // Still executing, don't start new action
      return {};
    }

    const action = cognitiveDecision.action;
    if (!action) return {};

    // Don't re-execute a decision we already processed
    if (cognitiveDecision.timestamp <= lastProcessedDecisionTs) {
      return {};
    }
    lastProcessedDecisionTs = cognitiveDecision.timestamp;
    logger.info(`Executing action: ${action.type} (params: ${JSON.stringify(action.params).substring(0, 80)})`);

    // ── Execute the action ─────────────────────────────────────────────────

    const awareness: ActionAwareness = {
      lastResult: actionAwareness.lastResult,
      recentResults: [...actionAwareness.recentResults],
      isBusy: true,
      busySince: Date.now(),
    };

    // Start action asynchronously
    const startTime = Date.now();

    try {
      const outcome = await executeAction(action, context);

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

      logger.debug(`Action ${action.type} failed: ${errMsg}`);
    }

    // Trim recent results
    if (awareness.recentResults.length > MAX_RECENT_RESULTS) {
      awareness.recentResults = awareness.recentResults.slice(-MAX_RECENT_RESULTS);
    }

    return { actionAwareness: awareness };
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
