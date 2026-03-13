/**
 * Spawner — Creates and manages Mineflayer bot instances for each agent.
 *
 * Reads agent profiles from config, creates bot connections, wires up
 * PIANO modules, and manages the agent lifecycle.
 */

import { createBot, Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { AgentIdentity, AgentState, ChatEntry, Goal, GoalCategory, createDefaultAgentState } from '../agent/AgentState';
import { ModuleRunner, ModuleContext } from '../agent/ModuleRunner';
import { CommunicationBus } from './CommunicationBus';
import { LLMClient } from '../llm/LLMClient';
import { Logger } from '../utils/Logger';

import { PerceptionModule } from '../modules/PerceptionModule';
import { MemoryModule } from '../modules/MemoryModule';
import { SocialAwarenessModule } from '../modules/SocialAwarenessModule';
import { GoalGenerationModule } from '../modules/GoalGenerationModule';
import { CognitiveControllerModule } from '../modules/CognitiveController';
import { createActionModule } from '../modules/ActionModule';
import { createTalkingModule } from '../modules/TalkingModule';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentProfile {
  name: string;
  traits: string[];
  backstory?: string;
  communityGoal: string;
  spawnLocation: { x: number; y: number; z: number };
  /** Per-agent LLM provider override (defaults to global) */
  provider?: 'cerebras' | 'ollama';
  /** Per-agent LLM model override (defaults to global) */
  model?: string;
  /** Per-agent LLM host override (e.g. a different Ollama instance URL) */
  host?: string;
  inventory?: Record<string, number>;
  locationMemories?: Array<{
    description: string;
    position: { x: number; y: number; z: number };
    category: 'resource' | 'structure' | 'danger' | 'social' | 'other';
  }>;
  startingGoals?: Array<{
    category: string;
    description: string;
    priority: number;
    steps?: string[];
  }>;
}

export interface ServerConfig {
  host: string;
  port: number;
  version?: string;
}

export interface SpawnedAgent {
  profile: AgentProfile;
  bot: Bot;
  state: AgentState;
  runner: ModuleRunner;
}

// ── Spawner ──────────────────────────────────────────────────────────────────

export class Spawner {
  private agents: Map<string, SpawnedAgent> = new Map();
  private reconnectTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private stopped = false;
  private commBus: CommunicationBus;
  private llm: LLMClient;
  private serverConfig: ServerConfig;
  private logger: Logger;

  constructor(serverConfig: ServerConfig, llm: LLMClient, commBus: CommunicationBus) {
    this.serverConfig = serverConfig;
    this.llm = llm;
    this.commBus = commBus;
    this.logger = new Logger('Spawner');
  }

  async spawnAgents(profiles: AgentProfile[], staggerMs: number = 500): Promise<void> {
    this.stopped = false; // Reset for new simulation run
    this.logger.info(`Spawning ${profiles.length} agents (stagger: ${staggerMs}ms)...`);

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      try {
        await this.spawnAgent(profile);
        this.logger.info(`Spawned agent ${i + 1}/${profiles.length}: ${profile.name}`);
      } catch (error) {
        this.logger.error(`Failed to spawn ${profile.name}:`, error);
      }
      if (i < profiles.length - 1) {
        await new Promise(r => setTimeout(r, staggerMs));
      }
    }

    this.logger.info(`All agents spawned. Active: ${this.agents.size}/${profiles.length}`);
  }

  async spawnAgent(profile: AgentProfile): Promise<SpawnedAgent> {
    const bot = createBot({
      host: this.serverConfig.host,
      port: this.serverConfig.port,
      username: profile.name,
      version: this.serverConfig.version,
      auth: 'offline',
      hideErrors: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Spawn timeout')), 30_000);
      bot.once('spawn', () => { clearTimeout(timeout); resolve(); });
      bot.once('error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    bot.loadPlugin(pathfinder);

    const identity: AgentIdentity = {
      name: profile.name,
      traits: profile.traits,
      communityGoal: profile.communityGoal,
      spawnLocation: new Vec3(profile.spawnLocation.x, profile.spawnLocation.y, profile.spawnLocation.z),
      backstory: profile.backstory || `${profile.name} is a member of the community.`,
      provider: profile.provider,
      model: profile.model,
      host: profile.host,
    };

    const state = createDefaultAgentState(identity);

    if (profile.locationMemories) {
      for (const lm of profile.locationMemories) {
        state.locationMemories.push({
          description: lm.description,
          position: new Vec3(lm.position.x, lm.position.y, lm.position.z),
          category: lm.category,
          discoveredAt: Date.now(),
        });
      }
    }

    // Seed starting goals from config
    if (profile.startingGoals?.length) {
      const validCategories = ['survival','social','economic','civic','exploration','religious'];
      const { v4: uuidv4 } = require('uuid');
      state.goals.currentGoals = profile.startingGoals.map((g, i) => ({
        id: uuidv4(),
        category: (validCategories.includes(g.category) ? g.category : 'survival') as GoalCategory,
        description: g.description,
        priority: g.priority ?? (10 - i),
        steps: g.steps,
        completed: false,
        active: true,
        createdAt: Date.now(),
      } as Goal));
    }

    const context: ModuleContext = {
      bot,
      llm: this.llm,
      sendChat: (message: string) => {
        this.commBus.broadcast(profile.name, message);
        bot.chat(message);
      },
      simTime: Date.now(),
      agentName: profile.name,
      agentProvider: profile.provider,
      agentModel: profile.model,
      agentHost: profile.host,
    };

    const runner = new ModuleRunner(state, context);

    // Small per-agent offset so initial LLM calls don't all fire at the exact same ms.
    // After the first call, each agent self-reschedules independently so they stay concurrent.
    const agentIndex = this.agents.size;
    const agentOffsetMs = agentIndex * 500; // 0.5s between each agent's first module starts

    runner.register({ name: 'Perception',         execute: PerceptionModule,          intervalMs: 1000,  priority: 10, enabled: true, startDelayMs: agentOffsetMs });
    runner.register({ name: 'Memory',             execute: MemoryModule,              intervalMs: 10000, priority: 8,  enabled: true, startDelayMs: agentOffsetMs + 100 });
    runner.register({ name: 'SocialAwareness',    execute: SocialAwarenessModule,     intervalMs: 15000, priority: 6,  enabled: true, startDelayMs: agentOffsetMs + 200 });
    runner.register({ name: 'GoalGeneration',     execute: GoalGenerationModule,      intervalMs: 30000, priority: 5,  enabled: true, startDelayMs: agentOffsetMs + 300 });
    runner.register({ name: 'CognitiveController',execute: CognitiveControllerModule, intervalMs: 3000,  priority: 9,  enabled: true, startDelayMs: agentOffsetMs + 400 });
    runner.register({ name: 'Action',             execute: createActionModule(),       intervalMs: 1000,  priority: 7,  enabled: true, startDelayMs: agentOffsetMs + 500 });
    runner.register({ name: 'Talking',            execute: createTalkingModule(),      intervalMs: 2000,  priority: 7,  enabled: true, startDelayMs: agentOffsetMs + 600 });

    this.commBus.registerAgent({
      name: profile.name,
      getPosition: () => bot.entity?.position?.clone() ?? null,
      deliverChat: (entry: ChatEntry) => {
        const agentState = runner.getMutableState();
        agentState.perception.recentChat.push(entry);
        if (agentState.perception.recentChat.length > 30) {
          agentState.perception.recentChat = agentState.perception.recentChat.slice(-20);
        }
      },
    });

    bot.on('death', () => { this.logger.warn(`${profile.name} died!`); state.isAlive = false; });
    bot.on('end', (reason: string) => {
      this.logger.warn(`${profile.name} disconnected: ${reason}`);
      state.isAlive = false;
      runner.stop();
      this.scheduleReconnect(profile);
    });
    bot.on('error', (err: Error) => { this.logger.error(`${profile.name} error: ${err.message}`); });

    // ── Listen to Minecraft server chat (captures human player messages) ────
    // The CommunicationBus only handles inter-agent chat. This listener
    // picks up messages from human players so the agent can hear and respond.
    const allAgentNames = new Set<string>();
    // We'll also add this bot's own name so we can filter it out
    allAgentNames.add(profile.name);

    bot.on('chat' as any, (username: string, message: string) => {
      // Skip our own messages
      if (username === profile.name || username === bot.username) return;
      // Skip messages from other registered agents (already handled by CommunicationBus)
      if (this.agents.has(username)) return;

      // This is a human player message — inject into agent's perception
      const agentState = runner.getMutableState();
      const entry: ChatEntry = {
        sender: username,
        message,
        timestamp: Date.now(),
        isProximity: true,
      };
      agentState.perception.recentChat.push(entry);
      if (agentState.perception.recentChat.length > 30) {
        agentState.perception.recentChat = agentState.perception.recentChat.slice(-20);
      }
      this.logger.info(`${profile.name} heard player ${username}: "${message.substring(0, 80)}"`);
    });

    // Anti-idle heartbeat: prevent Minecraft server from kicking idle bots
    const heartbeat = setInterval(() => {
      if (!state.isAlive) { clearInterval(heartbeat); return; }
      try {
        bot.swingArm('right');
      } catch { /* bot may be disconnected */ }
    }, 45_000);
    bot.once('end', () => clearInterval(heartbeat));

    try { bot.chat(`/tp ${profile.spawnLocation.x} ${profile.spawnLocation.y} ${profile.spawnLocation.z}`); } catch { /* no TP perms */ }

    const spawned: SpawnedAgent = { profile, bot, state, runner };
    this.agents.set(profile.name, spawned);
    return spawned;
  }

  startAll(): void {
    for (const agent of this.agents.values()) { agent.runner.start(); }
    this.logger.info(`Started all ${this.agents.size} agent module runners`);
  }

  startAgent(name: string): boolean {
    const agent = this.agents.get(name);
    if (!agent) return false;
    agent.runner.start();
    this.logger.info(`Started agent module runner: ${name}`);
    return true;
  }

  /** Spawn a single agent into MC, connect, and start its AI loop in one step. */
  async spawnAndStartAgent(profile: AgentProfile): Promise<boolean> {
    if (this.agents.has(profile.name)) {
      this.logger.warn(`${profile.name} is already spawned — skipping`);
      return false;
    }
    this.stopped = false;
    try {
      const spawned = await this.spawnAgent(profile);
      spawned.runner.start();
      this.logger.info(`Spawned and started agent: ${profile.name}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to spawn+start ${profile.name}:`, error);
      return false;
    }
  }

  /** Spawn and start all agents from a list of profiles. */
  async spawnAndStartAll(profiles: AgentProfile[], staggerMs: number = 500): Promise<void> {
    this.stopped = false;
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      if (this.agents.has(profile.name)) {
        // Already spawned — just make sure runner is started
        this.agents.get(profile.name)!.runner.start();
        continue;
      }
      try {
        const spawned = await this.spawnAgent(profile);
        spawned.runner.start();
        this.logger.info(`Spawned+started agent ${i + 1}/${profiles.length}: ${profile.name}`);
      } catch (error) {
        this.logger.error(`Failed to spawn ${profile.name}:`, error);
      }
      if (i < profiles.length - 1) await new Promise(r => setTimeout(r, staggerMs));
    }
    this.logger.info(`All agents spawned+started. Active: ${this.agents.size}/${profiles.length}`);
  }

  private scheduleReconnect(profile: AgentProfile, attempt = 1): void {
    if (this.stopped) {
      this.logger.info(`${profile.name}: skipping reconnect — simulation stopped`);
      return;
    }
    const maxAttempts = 10;
    if (attempt > maxAttempts) {
      this.logger.error(`${profile.name}: giving up after ${maxAttempts} reconnect attempts`);
      return;
    }
    // Exponential backoff: 5s, 10s, 20s … capped at 60s
    const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 60_000);
    this.logger.info(`${profile.name}: reconnecting in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})...`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(timer);
      if (this.stopped) return; // Check again after delay
      try {
        this.agents.delete(profile.name);
        this.commBus.unregisterAgent(profile.name);
        const spawned = await this.spawnAgent(profile);
        spawned.runner.start();
        this.logger.info(`${profile.name}: reconnected successfully`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`${profile.name}: reconnect attempt ${attempt} failed: ${msg}`);
        this.scheduleReconnect(profile, attempt + 1);
      }
    }, delayMs);
    this.reconnectTimers.add(timer);
  }

  stopAll(): void {
    this.stopped = true;
    // Cancel all pending reconnect timers
    for (const timer of this.reconnectTimers) { clearTimeout(timer); }
    this.reconnectTimers.clear();
    for (const agent of this.agents.values()) { agent.runner.stop(); agent.bot.quit(); }
    this.agents.clear();
    this.logger.info('Stopped all agents and cancelled pending reconnects');
  }

  getAgent(name: string): SpawnedAgent | undefined { return this.agents.get(name); }
  getAllAgents(): SpawnedAgent[] { return Array.from(this.agents.values()); }

  getAgentStates(): Map<string, Readonly<AgentState>> {
    const states = new Map<string, Readonly<AgentState>>();
    for (const [name, agent] of this.agents) { states.set(name, agent.runner.getState()); }
    return states;
  }

  getAgentCount(): number { return this.agents.size; }
}
