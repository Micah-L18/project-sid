/**
 * PerceptionModule — Polls Mineflayer APIs and writes structured observations
 * to AgentState.perception. Runs every ~1 second (fast module).
 *
 * Implements proximity-based hearing: only chat from entities within
 * the configured hearing radius is delivered to the agent.
 */

import { AgentState, AgentPerception, NearbyEntity, NearbyBlock, InventoryItem } from '../agent/AgentState';
import { PianoModule, ModuleContext } from '../agent/ModuleRunner';
import { Vec3 } from 'vec3';

// ── Configuration ────────────────────────────────────────────────────────────

const PERCEPTION_RADIUS = 32;      // blocks — how far the agent "sees"
const HEARING_RADIUS = 32;         // blocks — how far the agent "hears" chat
const MAX_NEARBY_ENTITIES = 20;
const MAX_NEARBY_BLOCKS = 30;
const MAX_RECENT_CHAT = 20;
const NOTABLE_BLOCKS = new Set([
  'diamond_ore', 'deepslate_diamond_ore',
  'iron_ore', 'deepslate_iron_ore',
  'gold_ore', 'deepslate_gold_ore',
  'coal_ore', 'deepslate_coal_ore',
  'copper_ore', 'deepslate_copper_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'emerald_ore', 'deepslate_emerald_ore',
  'chest', 'crafting_table', 'furnace', 'blast_furnace', 'smoker',
  'enchanting_table', 'anvil', 'brewing_stand',
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'wheat', 'carrots', 'potatoes', 'beetroots',
  'water', 'lava',
]);

// ── Module Implementation ────────────────────────────────────────────────────

export const PerceptionModule: PianoModule = async (
  state: Readonly<AgentState>,
  context: ModuleContext
): Promise<Partial<AgentState>> => {
  const { bot } = context;

  if (!bot.entity) {
    return {}; // Bot not spawned yet
  }

  const position = bot.entity.position.clone();

  // ── Gather nearby entities ───────────────────────────────────────────────

  const nearbyEntities: NearbyEntity[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity) continue;
    if (!entity.position) continue;

    const distance = position.distanceTo(entity.position);
    if (distance > PERCEPTION_RADIUS) continue;

    nearbyEntities.push({
      name: entity.username || entity.displayName || entity.name || 'unknown',
      type: entity.type || 'unknown',
      position: entity.position.clone(),
      distance: Math.round(distance * 10) / 10,
      health: (entity as any).health,
    });
  }

  // Sort by distance, cap at max
  nearbyEntities.sort((a, b) => a.distance - b.distance);
  nearbyEntities.splice(MAX_NEARBY_ENTITIES);

  // ── Scan for notable blocks ──────────────────────────────────────────────

  const nearbyBlocks: NearbyBlock[] = [];
  const scanRadius = Math.min(PERCEPTION_RADIUS, 16); // Limit block scan radius for performance

  for (let dx = -scanRadius; dx <= scanRadius; dx += 2) {
    for (let dy = -scanRadius / 2; dy <= scanRadius / 2; dy += 2) {
      for (let dz = -scanRadius; dz <= scanRadius; dz += 2) {
        const blockPos = position.offset(dx, dy, dz);
        try {
          const block = bot.blockAt(blockPos);
          if (block && NOTABLE_BLOCKS.has(block.name)) {
            nearbyBlocks.push({
              name: block.name,
              position: blockPos,
              distance: Math.round(position.distanceTo(blockPos) * 10) / 10,
            });
          }
        } catch {
          // Block out of loaded chunks
        }
      }
    }
  }

  nearbyBlocks.sort((a, b) => a.distance - b.distance);
  nearbyBlocks.splice(MAX_NEARBY_BLOCKS);

  // ── Read inventory ───────────────────────────────────────────────────────

  const inventory: InventoryItem[] = bot.inventory.items().map(item => ({
    name: item.name,
    count: item.count,
    slot: item.slot,
  }));

  // ── Build perception update ──────────────────────────────────────────────

  const perception: AgentPerception = {
    nearbyEntities,
    nearbyBlocks,
    inventory,
    health: bot.health ?? 20,
    food: bot.food ?? 20,
    position,
    isDay: bot.time?.isDay ?? true,
    isRaining: bot.isRaining ?? false,
    gameTime: bot.time?.age ?? 0,
    // Keep existing chat — it's managed by the CommunicationBus
    recentChat: state.perception.recentChat.slice(-MAX_RECENT_CHAT),
    lastUpdated: Date.now(),
  };

  return { perception };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a text summary of current perception for use by other modules.
 */
export function summarizePerception(perception: AgentPerception): string {
  const lines: string[] = [];

  lines.push(`Position: (${Math.round(perception.position.x)}, ${Math.round(perception.position.y)}, ${Math.round(perception.position.z)})`);
  lines.push(`Health: ${perception.health}/20 | Food: ${perception.food}/20`);
  lines.push(`Time: ${perception.isDay ? 'Day' : 'Night'} | Weather: ${perception.isRaining ? 'Raining' : 'Clear'}`);

  if (perception.nearbyEntities.length > 0) {
    const entityList = perception.nearbyEntities
      .slice(0, 8)
      .map(e => `${e.name} (${e.type}, ${e.distance}m)`)
      .join(', ');
    lines.push(`Nearby: ${entityList}`);
  } else {
    lines.push('Nearby: No one around');
  }

  if (perception.nearbyBlocks.length > 0) {
    // Group blocks by type with closest position and direction
    const blockInfo = new Map<string, { count: number; closest: { pos: Vec3; dist: number } }>();
    for (const b of perception.nearbyBlocks) {
      const existing = blockInfo.get(b.name);
      if (!existing || b.distance < existing.closest.dist) {
        blockInfo.set(b.name, { count: (existing?.count ?? 0) + 1, closest: { pos: b.position, dist: b.distance } });
      } else {
        existing.count++;
      }
    }
    const blockList = Array.from(blockInfo.entries())
      .map(([name, info]) => {
        const p = info.closest.pos;
        const dir = describeDirection(perception.position, p);
        const vertLabel = p.y > perception.position.y + 2 ? ' (above)' :
                          p.y < perception.position.y - 2 ? ' (below/underground)' : '';
        return `${name}×${info.count} — closest ${info.closest.dist}m ${dir}${vertLabel} at y=${Math.round(p.y)}`;
      })
      .join('\n  ');
    lines.push(`Notable blocks nearby:\n  ${blockList}`);
  } else {
    lines.push('Notable blocks: None visible nearby — explore on the surface to find trees');
  }

  if (perception.inventory.length > 0) {
    const invList = perception.inventory
      .map(i => `${i.name}×${i.count}`)
      .join(', ');
    lines.push(`Inventory: ${invList}`);
  } else {
    lines.push('Inventory: Empty');
  }

  // Progression status — tells the CC what it can and cannot do right now
  lines.push(getProgressionStatus(perception.inventory));

  if (perception.recentChat.length > 0) {
    const recentMessages = perception.recentChat
      .slice(-5)
      .map(c => `${c.sender}: "${c.message}"`)
      .join('\n  ');
    lines.push(`Recent chat:\n  ${recentMessages}`);
  }

  return lines.join('\n');
}

/** Compass direction from `from` to `to`. */
function describeDirection(from: Vec3, to: Vec3): string {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const angle = Math.atan2(-dz, dx) * (180 / Math.PI); // Minecraft: -Z = north
  if (angle >= -22.5 && angle < 22.5) return 'to the east';
  if (angle >= 22.5 && angle < 67.5) return 'to the northeast';
  if (angle >= 67.5 && angle < 112.5) return 'to the north';
  if (angle >= 112.5 && angle < 157.5) return 'to the northwest';
  if (angle >= 157.5 || angle < -157.5) return 'to the west';
  if (angle >= -157.5 && angle < -112.5) return 'to the southwest';
  if (angle >= -112.5 && angle < -67.5) return 'to the south';
  return 'to the southeast';
}

// ── Progression status ────────────────────────────────────────────────────────

/**
 * Computes a human-readable Minecraft tech-tree status from the current inventory.
 * Exported so CognitiveController can also inject it directly.
 */
export function getProgressionStatus(inventory: { name: string; count: number }[]): string {
  const inv = new Set(inventory.map(i => i.name));
  const has = (...items: string[]) => items.some(it => inv.has(it));

  const hasAxe      = has('wooden_axe','stone_axe','iron_axe','diamond_axe','golden_axe','netherite_axe');
  const hasPick1    = has('wooden_pickaxe');
  const hasPick2    = has('stone_pickaxe','iron_pickaxe','diamond_pickaxe','golden_pickaxe','netherite_pickaxe');
  const hasPick3    = has('iron_pickaxe','diamond_pickaxe','netherite_pickaxe');
  const hasWood     = has('oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log',
                          'oak_planks','spruce_planks','birch_planks');
  const hasPlanks   = has('oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks');
  const hasTable    = has('crafting_table');
  const hasCoal     = has('coal');
  const hasIronOre  = has('iron_ore','deepslate_iron_ore','raw_iron');
  const hasIronIngot= has('iron_ingot');
  const hasFurnace  = has('furnace');

  // Determine tier
  let tier = 0;
  if (hasWood || hasPlanks) tier = 1;
  if (hasTable) tier = 2;
  if (hasPick1) tier = 3;
  if (hasPick2) tier = 4;
  if (hasIronIngot) tier = 5;
  if (hasPick3) tier = 6;

  const lines: string[] = [`Tech tier: ${tier}`];

  // What's possible right now
  const canDo: string[] = [];
  const needs: string[] = [];

  if (!hasWood) {
    needs.push('punch oak_log with bare hands to get wood (no tool needed)');
  } else if (!hasPlanks) {
    canDo.push('craft oak_planks from logs (4 per log, no table needed)');
  } else if (!hasTable) {
    canDo.push('craft crafting_table from 4 planks (no table needed)');
  } else if (!hasPick1) {
    canDo.push('craft wooden_pickaxe: 3 planks + 2 sticks at crafting_table');
  } else if (!hasPick2 && hasCoal) {
    canDo.push('mine more stone then craft stone_pickaxe: 3 cobblestone + 2 sticks');
  } else if (!hasPick2) {
    canDo.push('mine coal_ore and stone with wooden_pickaxe');
  } else if (hasIronOre && !hasFurnace) {
    canDo.push('craft furnace from 8 cobblestone to smelt iron_ore');
  } else if (hasIronOre && hasFurnace && !hasIronIngot) {
    canDo.push('smelt iron_ore in furnace to get iron_ingot');
  } else if (hasIronIngot && !hasPick3) {
    canDo.push('craft iron_pickaxe: 3 iron_ingot + 2 sticks at crafting_table');
  }

  if (!hasAxe && hasTable && hasPlanks) {
    canDo.push('craft wooden_axe for faster wood chopping');
  }

  if (canDo.length) lines.push(`Next steps: ${canDo.join(' | ')}`);
  if (needs.length) lines.push(`Must do first: ${needs.join(' | ')}`);

  // What cannot be mined yet
  const blocked: string[] = [];
  if (!hasPick1) blocked.push('coal_ore/stone (need wooden_pickaxe)');
  if (!hasPick2) blocked.push('iron_ore/gold_ore (need stone_pickaxe)');
  if (!hasPick3) blocked.push('diamond_ore (need iron_pickaxe)');
  if (blocked.length) lines.push(`Cannot mine yet: ${blocked.join(', ')}`);

  return lines.join('\n');
}

// ── Export config for external tweaking ───────────────────────────────────────

export const PerceptionConfig = {
  PERCEPTION_RADIUS,
  HEARING_RADIUS,
  MAX_NEARBY_ENTITIES,
  MAX_NEARBY_BLOCKS,
  MAX_RECENT_CHAT,
  NOTABLE_BLOCKS,
};
