/**
 * Project Sid — Entry Point
 *
 * Many-agent simulations toward AI civilization.
 * Replication of the PIANO architecture from arXiv:2411.00114.
 *
 * Usage:
 *   npm run dev                          # Run with default config
 *   npm run dev -- --config custom.json  # Custom config
 *   npm run dev -- --agents 5            # Override agent count
 */

import 'dotenv/config';

import { LLMClient, LLMConfig } from './llm/LLMClient';
import { CommunicationBus } from './orchestrator/CommunicationBus';
import { Spawner, AgentProfile, ServerConfig } from './orchestrator/Spawner';
import { WorldState } from './orchestrator/WorldState';
import { ElectionManager } from './governance/ElectionManager';
import { TaxCollector } from './governance/TaxCollector';
import { BenchmarkRunner } from './benchmarks/BenchmarkRunner';
import { Dashboard } from './dashboard/Dashboard';
import { SimulationStore } from './simulation/SimulationStore';
import { Logger, setGlobalLogLevel, LogLevel } from './utils/Logger';

import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ────────────────────────────────────────────────────────────

interface Config {
  server: ServerConfig;
  llm: Partial<LLMConfig>;
  simulation: {
    hearingRadius: number;
    staggerSpawnMs: number;
    benchmarkIntervalMs: number;
    electionIntervalMs: number;
    taxCheckIntervalMs: number;
    dashboardPort: number;
  };
  agents: AgentProfile[];
}

function loadConfig(): Config {
  // Check for custom config path in args
  const configArgIndex = process.argv.indexOf('--config');
  const configPath = configArgIndex >= 0
    ? path.resolve(process.argv[configArgIndex + 1])
    : path.resolve(__dirname, 'config', 'default.json');

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config: Config = JSON.parse(raw);

  // Override agent count if specified
  const agentArgIndex = process.argv.indexOf('--agents');
  if (agentArgIndex >= 0) {
    const count = parseInt(process.argv[agentArgIndex + 1]);
    if (count > 0 && count < config.agents.length) {
      config.agents = config.agents.slice(0, count);
    }
  }

  // Log level
  const logArgIndex = process.argv.indexOf('--log');
  if (logArgIndex >= 0) {
    setGlobalLogLevel(process.argv[logArgIndex + 1] as LogLevel);
  }

  return config;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const logger = new Logger('Main');
  logger.info('╔══════════════════════════════════════════════╗');
  logger.info('║   Project Sid — AI Civilization Simulation   ║');
  logger.info('║   PIANO Architecture Replication             ║');
  logger.info('╚══════════════════════════════════════════════╝');

  const config = loadConfig();
  logger.info(`Config loaded: ${config.agents.length} agents, server ${config.server.host}:${config.server.port}`);

  const llm = new LLMClient(config.llm);
  logger.info('Checking LLM availability...');
  const llmAvailable = await llm.isAvailable();
  if (!llmAvailable) {
    logger.error('❌ LLM (Cerebras) is not available. Check your API key and network connection.');
    process.exit(1);
  }
  const models = await llm.listModels();
  logger.info(`LLM ready. Available models: ${models.join(', ')}`);

  // Persistent run storage
  const store = new SimulationStore();

  // Core systems (always alive, shared across runs)
  const commBus = new CommunicationBus(config.simulation.hearingRadius);
  const worldState = new WorldState();
  commBus.setWorldState(worldState);
  worldState.tax.chestLocations.push({ x: 100, y: 64, z: 95 });

  const spawner = new Spawner(config.server, llm, commBus);
  const electionManager = new ElectionManager(llm, worldState, () => spawner.getAllAgents());
  const taxCollector = new TaxCollector(worldState, () => spawner.getAllAgents());
  const benchmarkRunner = new BenchmarkRunner(() => spawner.getAllAgents(), worldState, taxCollector);

  // Dashboard starts immediately so the user can see the UI and press Start
  const dashboard = new Dashboard(
    spawner, worldState, commBus, benchmarkRunner, llm, store,
    config.simulation.dashboardPort
  );

  // ── Run lifecycle ─────────────────────────────────────────────────────────

  let runId: string | null = null;
  let runStartedAt: Date | null = null;
  let simRunning = false;

  const stopSimulation = async (reason = 'manual') => {
    if (!simRunning) return;
    simRunning = false;
    logger.info(`Stopping simulation (reason: ${reason})...`);

    dashboard.setSimulationState('stopping');

    benchmarkRunner.stop();
    electionManager.stop();
    taxCollector.stop();
    spawner.stopAll();
    dashboard.stopUpdates();

    // Save the completed run
    if (runId && runStartedAt) {
      const endedAt = new Date();
      store.save({
        id: runId,
        startedAt: runStartedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        agentNames: config.agents.map(a => a.name),
        durationMs: endedAt.getTime() - runStartedAt.getTime(),
        finalBenchmark: benchmarkRunner.getLatestSnapshot() ?? null,
        config: { agents: config.agents.map(a => ({ name: a.name, traits: a.traits, communityGoal: a.communityGoal })), server: config.server },
        benchmarkHistory: [...benchmarkRunner.getSnapshots()],
        world: worldState.toJSON(),
        agents: spawner.getAllAgents().map(a => ({
          name: a.profile.name,
          traits: a.profile.traits,
          isAlive: a.state.isAlive,
          position: a.state.perception.position,
          inventory: a.state.perception.inventory,
          goals: a.state.goals.currentGoals,
          shortTermMemory: a.state.memory.shortTermMemory,
          relationships: Object.fromEntries(a.state.social.relationships),
          lastDecision: a.state.cognitiveDecision,
          moduleStats: a.runner.getModuleStats(),
        })),
        chatLog: commBus.getRecentChat(1000),
        llmStats: llm.getStats(),
      });
    }

    dashboard.setSimulationState('idle');
    logger.info('Simulation stopped and saved.');
  };

  // Register start/stop callbacks with the dashboard
  // Phase 1: "Start" sets up the run and transitions to 'spawned' (config view)
  // NO agents are connected to MC yet — the user picks which ones to start.
  dashboard.onStartRequested(async () => {
    if (simRunning) return;
    simRunning = true;
    runId = SimulationStore.generateId();
    runStartedAt = new Date();

    dashboard.setAgentProfiles(config.agents);
    dashboard.setSimulationState('spawned', runId);
    dashboard.startUpdates(2000);

    logger.info('════════════════════════════════════════════════');
    logger.info(`🔵 Run ${runId} — ${config.agents.length} agents ready to configure`);
    logger.info('   Start agents individually or press Start All in the dashboard.');
    logger.info('════════════════════════════════════════════════');
  });

  // Phase 2a: "Start All" spawns + connects + starts every agent at once
  dashboard.onStartAllRequested(async () => {
    logger.info('Starting all agents...');
    await spawner.spawnAndStartAll(config.agents, config.simulation.staggerSpawnMs);
    worldState.stats.agentsAlive = spawner.getAgentCount();
    electionManager.start();
    taxCollector.start(config.simulation.taxCheckIntervalMs);
    benchmarkRunner.start(config.simulation.benchmarkIntervalMs);
    dashboard.setSimulationState('running', runId!);

    logger.info('════════════════════════════════════════════════');
    logger.info(`✅ Run ${runId} — ${spawner.getAgentCount()} agents active`);
    logger.info(`📊 Dashboard: http://localhost:${config.simulation.dashboardPort}`);
    logger.info('════════════════════════════════════════════════');
  });

  // Phase 2b: Start a single agent (spawn + connect + start AI)
  dashboard.onStartAgentRequested(async (name: string) => {
    const profile = config.agents.find(a => a.name === name);
    if (!profile) return false;
    // Already spawned?
    if (spawner.getAgent(name)) return false;

    const ok = await spawner.spawnAndStartAgent(profile);
    if (ok) {
      worldState.stats.agentsAlive = spawner.getAgentCount();
      logger.info(`▶ Agent ${name} spawned and started`);

      // If all agents are now running, transition to 'running' and start governance
      const allConnected = config.agents.every(a => spawner.getAgent(a.name));
      if (allConnected && dashboard.getSimulationState() === 'spawned') {
        electionManager.start();
        taxCollector.start(config.simulation.taxCheckIntervalMs);
        benchmarkRunner.start(config.simulation.benchmarkIntervalMs);
        dashboard.setSimulationState('running', runId!);
        logger.info('All agents now running — transitioning to running state');
      }
    }
    return ok;
  });

  dashboard.onStopRequested(() => stopSimulation('manual'));

  logger.info('════════════════════════════════════════════════');
  logger.info(`📊 Dashboard: http://localhost:${config.simulation.dashboardPort}`);
  logger.info('   Press Start in the UI to begin a simulation run.');
  logger.info('════════════════════════════════════════════════');

  // Graceful shutdown on Ctrl+C
  const shutdown = async () => {
    logger.info('\nShutting down...');
    await stopSimulation('SIGINT');
    dashboard.stop();
    logger.info('Goodbye!');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {}); // Keep alive
}

// ── Run ──────────────────────────────────────────────────────────────────────

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
