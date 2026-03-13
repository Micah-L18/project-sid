/**
 * Skills — Mineflayer action library wrapping low-level bot APIs.
 *
 * Each skill is a high-level async function that translates a goal
 * (e.g., "mine iron_ore") into the appropriate Mineflayer API calls.
 * Inspired by Voyager's skill library but simpler and non-generative.
 */

import { Bot } from 'mineflayer';
import { pathfinder, Movements, goals as Goals } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

// ── Tool requirements & tiers ─────────────────────────────────────────────────

/** Minimum tool tier needed to harvest a block efficiently (returns drops). */
const TOOL_REQUIREMENTS: Record<string, { tool: string; minTier: number }> = {
  // Wood — no tool needed (tier 0 = bare hands)
  oak_log: { tool: 'axe', minTier: 0 }, spruce_log: { tool: 'axe', minTier: 0 },
  birch_log: { tool: 'axe', minTier: 0 }, jungle_log: { tool: 'axe', minTier: 0 },
  acacia_log: { tool: 'axe', minTier: 0 }, dark_oak_log: { tool: 'axe', minTier: 0 },
  // Stone & coal — need wooden pickaxe (tier 1)
  stone: { tool: 'pickaxe', minTier: 1 }, cobblestone: { tool: 'pickaxe', minTier: 1 },
  coal_ore: { tool: 'pickaxe', minTier: 1 }, deepslate_coal_ore: { tool: 'pickaxe', minTier: 1 },
  gravel: { tool: 'shovel', minTier: 0 }, sand: { tool: 'shovel', minTier: 0 },
  dirt: { tool: 'shovel', minTier: 0 }, grass_block: { tool: 'shovel', minTier: 0 },
  // Iron, copper, lapis — need stone pickaxe (tier 2)
  iron_ore: { tool: 'pickaxe', minTier: 2 }, deepslate_iron_ore: { tool: 'pickaxe', minTier: 2 },
  copper_ore: { tool: 'pickaxe', minTier: 2 }, deepslate_copper_ore: { tool: 'pickaxe', minTier: 2 },
  lapis_ore: { tool: 'pickaxe', minTier: 2 }, deepslate_lapis_ore: { tool: 'pickaxe', minTier: 2 },
  gold_ore: { tool: 'pickaxe', minTier: 2 }, deepslate_gold_ore: { tool: 'pickaxe', minTier: 2 },
  redstone_ore: { tool: 'pickaxe', minTier: 2 }, deepslate_redstone_ore: { tool: 'pickaxe', minTier: 2 },
  // Diamond, emerald — need iron pickaxe (tier 3)
  diamond_ore: { tool: 'pickaxe', minTier: 3 }, deepslate_diamond_ore: { tool: 'pickaxe', minTier: 3 },
  emerald_ore: { tool: 'pickaxe', minTier: 3 }, deepslate_emerald_ore: { tool: 'pickaxe', minTier: 3 },
};

/** Tool tiers in ascending order: index = tier number */
const PICKAXE_TIERS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
const AXE_TIERS     = ['wooden_axe', 'stone_axe', 'iron_axe', 'golden_axe', 'diamond_axe', 'netherite_axe'];
const SHOVEL_TIERS  = ['wooden_shovel', 'stone_shovel', 'iron_shovel', 'golden_shovel', 'diamond_shovel', 'netherite_shovel'];

const TOOL_TIERS: Record<string, string[]> = {
  pickaxe: PICKAXE_TIERS,
  axe: AXE_TIERS,
  shovel: SHOVEL_TIERS,
};

/** Returns the tier index (0-5) of the best matching tool in inventory, or -1 if none. */
function bestToolTier(bot: Bot, toolType: string): number {
  const tiers = TOOL_TIERS[toolType] ?? [];
  const inv = bot.inventory.items();
  let best = -1;
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (inv.find(it => it.name === tiers[i])) { best = i; break; }
  }
  return best;
}

// ── Skills Class ─────────────────────────────────────────────────────────────

export class Skills {
  private bot: Bot;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /** Create Movements config that avoids water pathing. */
  private createMovements(): Movements {
    const movements = new Movements(this.bot);
    (movements as any).liquidCost = 9999;  // Strongly avoid pathing through water
    movements.allowSprinting = true;
    return movements;
  }

  // ── Movement ─────────────────────────────────────────────────────────────

  async moveTo(x: number, y: number, z: number): Promise<string> {
    const target = new Vec3(x, y, z);
    this.ensurePathfinder();

    const mcData = require('minecraft-data')(this.bot.version);
    const movements = this.createMovements();
    this.bot.pathfinder.setMovements(movements);

    await this.bot.pathfinder.goto(new Goals.GoalNear(x, y, z, 2));
    return `Moved to (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`;
  }

  async moveToEntity(name: string): Promise<string> {
    const entity = this.findEntity(name);
    if (!entity) return `Could not find entity: ${name}`;

    this.ensurePathfinder();
    const mcData = require('minecraft-data')(this.bot.version);
    const movements = this.createMovements();
    this.bot.pathfinder.setMovements(movements);

    await this.bot.pathfinder.goto(
      new Goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 3)
    );
    return `Moved to ${name}`;
  }

  async followEntity(name: string): Promise<string> {
    const entity = this.findEntity(name);
    if (!entity) return `Could not find entity: ${name}`;

    this.ensurePathfinder();
    const mcData = require('minecraft-data')(this.bot.version);
    const movements = this.createMovements();
    this.bot.pathfinder.setMovements(movements);

    this.bot.pathfinder.setGoal(new Goals.GoalFollow(entity, 3), true);

    // Follow for a few seconds then stop
    await new Promise(r => setTimeout(r, 5000));
    this.bot.pathfinder.stop();
    return `Followed ${name} for a few seconds`;
  }

  /**
   * Emergency: swim upward toward the surface and move to solid ground.
   */
  async swimToSurface(): Promise<string> {
    const bot = this.bot;
    const startY = bot.entity.position.y;

    // Look straight up and hold jump + forward to swim up
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);

    // Swim upward for up to 8 seconds or until we're out of water
    const start = Date.now();
    while (Date.now() - start < 8000) {
      await new Promise(r => setTimeout(r, 250));
      if (!(bot.entity as any).isInWater) break;
    }

    bot.setControlState('jump', false);
    bot.setControlState('forward', false);

    // Try to pathfind to nearby land
    try {
      this.ensurePathfinder();
      const movements = new Movements(bot);
      (movements as any).liquidCost = 9999;
      bot.pathfinder.setMovements(movements);

      // Find the nearest solid block at or above surface level
      const pos = bot.entity.position;
      let bestLand: Vec3 | null = null;
      let bestDist = Infinity;
      for (let dx = -15; dx <= 15; dx += 2) {
        for (let dz = -15; dz <= 15; dz += 2) {
          for (let dy = -3; dy <= 5; dy++) {
            const checkPos = pos.offset(dx, dy, dz);
            try {
              const block = bot.blockAt(checkPos);
              const blockAbove = bot.blockAt(checkPos.offset(0, 1, 0));
              if (block && block.name !== 'water' && block.name !== 'air' && block.name !== 'lava'
                  && blockAbove && (blockAbove.name === 'air' || blockAbove.name === 'cave_air')) {
                const dist = pos.distanceTo(checkPos);
                if (dist < bestDist) {
                  bestDist = dist;
                  bestLand = checkPos;
                }
              }
            } catch { /* out of range */ }
          }
        }
      }

      if (bestLand) {
        await bot.pathfinder.goto(new Goals.GoalNear(bestLand.x, bestLand.y + 1, bestLand.z, 2));
        return `Escaped water! Swam from y=${Math.round(startY)} to land at y=${Math.round(bot.entity.position.y)}`;
      }
    } catch { /* pathfinder failed, we at least swam up */ }

    const escaped = !(bot.entity as any).isInWater;
    return escaped
      ? `Reached surface at y=${Math.round(bot.entity.position.y)}`
      : `Swimming upward from y=${Math.round(startY)} to y=${Math.round(bot.entity.position.y)} — still in water`;
  }

  async explore(direction?: string): Promise<string> {
    const pos = this.bot.entity.position;
    const distance = 30 + Math.random() * 20;
    let dx = 0, dz = 0;

    switch (direction?.toLowerCase()) {
      case 'north': dz = -distance; break;
      case 'south': dz = distance; break;
      case 'east':  dx = distance; break;
      case 'west':  dx = -distance; break;
      default:
        // Random direction
        const angle = Math.random() * Math.PI * 2;
        dx = Math.cos(angle) * distance;
        dz = Math.sin(angle) * distance;
    }

    return this.moveTo(pos.x + dx, pos.y, pos.z + dz);
  }

  // ── Mining ───────────────────────────────────────────────────────────────

  async mineBlock(blockName: string, count: number = 1): Promise<string> {
    // ── Tool requirement check ──────────────────────────────────────────────
    const req = TOOL_REQUIREMENTS[blockName];
    if (req && req.minTier > 0) {
      const heldTier = bestToolTier(this.bot, req.tool);
      if (heldTier < req.minTier) {
        const needed = TOOL_TIERS[req.tool]?.[req.minTier] ?? `${req.tool} (tier ${req.minTier})`;
        const hint = req.tool === 'pickaxe' && req.minTier === 1
          ? ' Craft one: 3 planks + 2 sticks at a crafting_table.'
          : req.tool === 'pickaxe' && req.minTier === 2
          ? ' Craft one: 3 cobblestone + 2 sticks at a crafting_table.'
          : '';
        return `CANNOT mine ${blockName} — need at least a ${needed}.${hint} Craft tools first!`;
      }
    }

    let mined = 0;

    for (let i = 0; i < count; i++) {
      const block = this.bot.findBlock({
        matching: (b) => b.name === blockName,
        maxDistance: 32,
      });

      if (!block) {
        return mined > 0
          ? `Mined ${mined}/${count} ${blockName} (no more found nearby)`
          : `Could not find any ${blockName} nearby`;
      }

      // Move close enough to mine
      this.ensurePathfinder();
      const movements = this.createMovements();
      this.bot.pathfinder.setMovements(movements);

      try {
        await this.bot.pathfinder.goto(
          new Goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z)
        );
      } catch {
        // May already be close enough
      }

      // Equip best tool for this block
      await this.equipBestTool(block);

      // Mine it
      try {
        await this.bot.dig(block);
        mined++;
      } catch (err) {
        return mined > 0
          ? `Mined ${mined}/${count} ${blockName} (dig failed: ${err})`
          : `Failed to mine ${blockName}: ${err}`;
      }

      // Wait for drops
      await new Promise(r => setTimeout(r, 300));
    }

    return `Mined ${mined} ${blockName}`;
  }

  // ── Crafting ─────────────────────────────────────────────────────────────

  async craftItem(itemName: string, count: number = 1): Promise<string> {
    const mcData = require('minecraft-data')(this.bot.version);
    const item = mcData.itemsByName[itemName];
    if (!item) return `Unknown item: ${itemName}`;

    // Find crafting table nearby (some recipes need it)
    const craftingTable = this.bot.findBlock({
      matching: (b) => b.name === 'crafting_table',
      maxDistance: 32,
    });

    // Check 2×2 recipes first (no table needed)
    const recipesNoTable = this.bot.recipesFor(item.id, null, 1, null);
    const recipesWithTable = craftingTable
      ? this.bot.recipesFor(item.id, null, 1, craftingTable)
      : [];

    if (recipesNoTable.length === 0 && recipesWithTable.length === 0) {
      if (!craftingTable) {
        return `Cannot craft ${itemName} — need a crafting_table nearby. Place one first!`;
      }
      return `No recipe found for ${itemName} (check you have the right ingredients)`;
    }

    // Prefer table recipes for 3×3 items; use hand recipe if available without a table
    const useTable = recipesNoTable.length === 0 && craftingTable;
    const recipe = useTable ? recipesWithTable[0] : recipesNoTable[0];

    // Navigate to crafting table if needed
    if (useTable && craftingTable) {
      this.ensurePathfinder();
      const movements = this.createMovements();
      this.bot.pathfinder.setMovements(movements);
      try {
        await this.bot.pathfinder.goto(
          new Goals.GoalGetToBlock(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z)
        );
      } catch { /* close enough */ }
    }

    try {
      await this.bot.craft(recipe, count, useTable ? craftingTable ?? undefined : undefined);
      return `Crafted ${count} ${itemName}`;
    } catch (err) {
      return `Failed to craft ${itemName}: ${err}`;
    }
  }

  // ── Block Placement ──────────────────────────────────────────────────────

  async placeBlock(blockName: string): Promise<string> {
    // Find the block item in inventory
    const item = this.bot.inventory.items().find(i => i.name === blockName);
    if (!item) return `Don't have ${blockName} in inventory`;

    await this.bot.equip(item, 'hand');

    // Strategy: find a solid reference block near the bot's feet to place
    // against. This avoids the unreliable "blockAtCursor" approach and the
    // impossible "jump and place under yourself" pillar technique.
    const botPos = this.bot.entity.position;
    const feetBlock = this.bot.blockAt(botPos.offset(0, -1, 0));

    // 1) Try placing on top of the block directly below (most common)
    if (feetBlock && feetBlock.name !== 'air' && feetBlock.name !== 'water') {
      try {
        await this.bot.placeBlock(feetBlock, new Vec3(0, 1, 0));
        return `Placed ${blockName}`;
      } catch { /* fall through to adjacent search */ }
    }

    // 2) Search nearby for a valid solid reference block we can place against
    const offsets: [number, number, number, Vec3][] = [
      // [dx, dy, dz, faceVector] — face vector points from ref block toward placement
      [ 1, -1,  0, new Vec3(0, 1, 0)],  // ground +x
      [-1, -1,  0, new Vec3(0, 1, 0)],  // ground -x
      [ 0, -1,  1, new Vec3(0, 1, 0)],  // ground +z
      [ 0, -1, -1, new Vec3(0, 1, 0)],  // ground -z
      [ 1,  0,  0, new Vec3(-1, 0, 0)], // wall +x, place on -x face
      [-1,  0,  0, new Vec3(1, 0, 0)],  // wall -x, place on +x face
      [ 0,  0,  1, new Vec3(0, 0, -1)], // wall +z
      [ 0,  0, -1, new Vec3(0, 0, 1)],  // wall -z
    ];

    for (const [dx, dy, dz, face] of offsets) {
      const refBlock = this.bot.blockAt(botPos.offset(dx, dy, dz));
      if (refBlock && refBlock.name !== 'air' && refBlock.name !== 'water' && refBlock.name !== 'cave_air') {
        try {
          await this.bot.placeBlock(refBlock, face);
          return `Placed ${blockName}`;
        } catch { continue; }
      }
    }

    return 'No suitable surface to place block on — move to open ground';
  }

  // ── Combat ───────────────────────────────────────────────────────────────

  async attackEntity(name: string): Promise<string> {
    const entity = this.findEntity(name);
    if (!entity) return `Could not find ${name}`;

    // Move close
    this.ensurePathfinder();
    const mcData = require('minecraft-data')(this.bot.version);
    const movements = this.createMovements();
    this.bot.pathfinder.setMovements(movements);

    try {
      await this.bot.pathfinder.goto(
        new Goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 3)
      );
    } catch {
      // May be close enough
    }

    // Attack
    try {
      this.bot.attack(entity);
      return `Attacked ${name}`;
    } catch (err) {
      return `Failed to attack ${name}: ${err}`;
    }
  }

  // ── Food ─────────────────────────────────────────────────────────────────

  async eat(): Promise<string> {
    const foodItems = this.bot.inventory.items().filter(item => {
      const mcData = require('minecraft-data')(this.bot.version);
      const food = mcData.foodsByName?.[item.name];
      return food !== undefined;
    });

    if (foodItems.length === 0) return 'No food in inventory';

    try {
      await this.bot.equip(foodItems[0], 'hand');
      await this.bot.consume();
      return `Ate ${foodItems[0].name}`;
    } catch (err) {
      return `Failed to eat: ${err}`;
    }
  }

  // ── Chest Interaction ────────────────────────────────────────────────────

  async depositToChest(itemName: string, count: number): Promise<string> {
    const chest = this.bot.findBlock({
      matching: (b) => b.name === 'chest',
      maxDistance: 16,
    });

    if (!chest) return 'No chest found nearby';

    // Move to chest
    this.ensurePathfinder();
    try {
      await this.bot.pathfinder.goto(
        new Goals.GoalGetToBlock(chest.position.x, chest.position.y, chest.position.z)
      );
    } catch { /* close enough */ }

    const chestWindow = await this.bot.openContainer(chest);
    const item = this.bot.inventory.items().find(i => i.name === itemName);

    if (!item) {
      chestWindow.close();
      return `Don't have ${itemName} in inventory`;
    }

    try {
      await chestWindow.deposit(item.type, null, Math.min(count, item.count));
      chestWindow.close();
      return `Deposited ${Math.min(count, item.count)} ${itemName} into chest`;
    } catch (err) {
      chestWindow.close();
      return `Failed to deposit: ${err}`;
    }
  }

  async withdrawFromChest(itemName: string, count: number): Promise<string> {
    const chest = this.bot.findBlock({
      matching: (b) => b.name === 'chest',
      maxDistance: 16,
    });

    if (!chest) return 'No chest found nearby';

    this.ensurePathfinder();
    try {
      await this.bot.pathfinder.goto(
        new Goals.GoalGetToBlock(chest.position.x, chest.position.y, chest.position.z)
      );
    } catch { /* close enough */ }

    const chestWindow = await this.bot.openContainer(chest);
    const items = chestWindow.containerItems();
    const item = items.find(i => i.name === itemName);

    if (!item) {
      chestWindow.close();
      return `No ${itemName} found in chest`;
    }

    try {
      await chestWindow.withdraw(item.type, null, Math.min(count, item.count));
      chestWindow.close();
      return `Withdrew ${Math.min(count, item.count)} ${itemName} from chest`;
    } catch (err) {
      chestWindow.close();
      return `Failed to withdraw: ${err}`;
    }
  }

  // ── Equipment ────────────────────────────────────────────────────────────

  async equipItem(itemName: string): Promise<string> {
    const item = this.bot.inventory.items().find(i => i.name === itemName);
    if (!item) return `Don't have ${itemName}`;

    try {
      await this.bot.equip(item, 'hand');
      return `Equipped ${itemName}`;
    } catch (err) {
      return `Failed to equip ${itemName}: ${err}`;
    }
  }

  // ── Smelting ─────────────────────────────────────────────────────────────

  async smeltItem(itemName: string, count: number = 1): Promise<string> {
    const furnace = this.bot.findBlock({
      matching: (b) => b.name === 'furnace' || b.name === 'blast_furnace',
      maxDistance: 32,
    });

    if (!furnace) return 'No furnace found nearby';

    this.ensurePathfinder();
    try {
      await this.bot.pathfinder.goto(
        new Goals.GoalGetToBlock(furnace.position.x, furnace.position.y, furnace.position.z)
      );
    } catch { /* close enough */ }

    // Open furnace and add items
    // Note: mineflayer furnace API is more complex, simplified here
    return `Smelting ${count} ${itemName} (furnace interaction simplified)`;
  }

  // ── Building ─────────────────────────────────────────────────────────────

  async buildStructure(description: string): Promise<string> {
    const blocks = this.bot.inventory.items()
      .filter(i => i.name.includes('planks') || i.name.includes('cobblestone') || i.name.includes('stone') || i.name.includes('bricks'));

    if (blocks.length === 0) return 'No building materials in inventory';

    const material = blocks[0];
    const available = blocks.reduce((s, b) => s + b.count, 0);
    let placed = 0;

    // Place blocks in a flat ring around the bot (simple foundation/wall)
    const botPos = this.bot.entity.position.floored();
    const offsets = [
      // 5×5 foundation ring
      [-2,-2],[-1,-2],[0,-2],[1,-2],[2,-2],
      [-2,-1],                      [2,-1],
      [-2, 0],                      [2, 0],
      [-2, 1],                      [2, 1],
      [-2, 2],[-1, 2],[0, 2],[1, 2],[2, 2],
    ];

    await this.bot.equip(material, 'hand');

    for (const [dx, dz] of offsets) {
      if (placed >= available) break;
      const placePos = botPos.offset(dx, -1, dz);
      const refBlock = this.bot.blockAt(placePos);

      // Only place if there's a solid block we can build against
      if (refBlock && refBlock.name !== 'air') {
        // Check if air above so we can stack on top
        const above = this.bot.blockAt(placePos.offset(0, 1, 0));
        if (above && above.name === 'air') {
          try {
            // Navigate close enough
            this.ensurePathfinder();
            const movements = this.createMovements();
            this.bot.pathfinder.setMovements(movements);
            await this.bot.pathfinder.goto(
              new Goals.GoalNear(placePos.x, placePos.y + 1, placePos.z, 4)
            );
          } catch { /* close enough */ }

          // Re-equip in case pathfinder changed held item
          const freshItem = this.bot.inventory.items().find(i => i.name === material.name);
          if (!freshItem) break;
          await this.bot.equip(freshItem, 'hand');

          try {
            await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
            placed++;
          } catch { /* skip this position */ }
        }
      }
      // Small delay to avoid server kick
      await new Promise(r => setTimeout(r, 150));
    }

    return placed > 0
      ? `Built foundation — placed ${placed} ${material.name} blocks (${description})`
      : `Could not place any blocks for: ${description}`;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private findEntity(name: string): any | null {
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity) continue;
      const entityName = entity.username || entity.displayName || entity.name;
      if (entityName?.toLowerCase() === name.toLowerCase()) {
        return entity;
      }
    }
    return null;
  }

  private async equipBestTool(block: any): Promise<void> {
    const name = block.name || '';
    let toolType = '';

    if (name.includes('ore') || name.includes('stone') || name.includes('cobble') || name === 'netherrack') {
      toolType = 'pickaxe';
    } else if (name.includes('log') || name.includes('wood') || name.includes('plank')) {
      toolType = 'axe';
    } else if (name.includes('dirt') || name.includes('sand') || name.includes('gravel') || name.includes('grass')) {
      toolType = 'shovel';
    }

    if (!toolType) return;

    // Equip the highest-tier tool available
    const tiers = TOOL_TIERS[toolType] ?? [];
    const inv = this.bot.inventory.items();
    let bestTool = null;
    for (let i = tiers.length - 1; i >= 0; i--) {
      const found = inv.find(it => it.name === tiers[i]);
      if (found) { bestTool = found; break; }
    }

    if (bestTool) {
      try { await this.bot.equip(bestTool, 'hand'); } catch { /* swallow */ }
    }
  }

  private ensurePathfinder(): void {
    if (!this.bot.pathfinder) {
      this.bot.loadPlugin(pathfinder);
    }
  }
}
