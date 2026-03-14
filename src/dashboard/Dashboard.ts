/**
 * Dashboard — Real-time web UI for monitoring the simulation.
 *
 * Express HTTP server + WebSocket for live updates.
 * Shows: agent map, social graphs, role distributions, meme spread,
 * constitution, tax compliance, benchmark metrics, and chat log.
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { Spawner, SpawnedAgent, AgentProfile } from '../orchestrator/Spawner';
import { WorldState } from '../orchestrator/WorldState';
import { CommunicationBus } from '../orchestrator/CommunicationBus';
import { BenchmarkRunner } from '../benchmarks/BenchmarkRunner';
import { SimulationStore } from '../simulation/SimulationStore';
import { InventoryItem, Goal, SocialRelationship } from '../agent/AgentState';
import { LLMClient, LLMProvider } from '../llm/LLMClient';
import { Logger } from '../utils/Logger';

// ── Dashboard Server ─────────────────────────────────────────────────────────

export type SimulationState = 'idle' | 'starting' | 'spawned' | 'running' | 'stopping';

export class Dashboard {
  private app: express.Express;
  private server: http.Server;
  private wss: WebSocketServer;
  private logger: Logger;
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  private spawner: Spawner;
  private worldState: WorldState;
  private commBus: CommunicationBus;
  private benchmarks: BenchmarkRunner;
  private llm: LLMClient;
  private store: SimulationStore;

  private simulationState: SimulationState = 'idle';
  private currentRunId: string | null = null;
  private startCallback: (() => Promise<void>) | null = null;
  private stopCallback: (() => void) | null = null;
  private startAllCallback: (() => Promise<void>) | null = null;
  private startAgentCallback: ((name: string) => Promise<boolean>) | null = null;

  /** Agent profiles from config — available before agents are spawned */
  private agentProfiles: AgentProfile[] = [];

  constructor(
    spawner: Spawner,
    worldState: WorldState,
    commBus: CommunicationBus,
    benchmarks: BenchmarkRunner,
    llm: LLMClient,
    store: SimulationStore,
    port: number = 3001
  ) {
    this.spawner = spawner;
    this.worldState = worldState;
    this.commBus = commBus;
    this.benchmarks = benchmarks;
    this.llm = llm;
    this.store = store;
    this.logger = new Logger('Dashboard');

    // Express app
    this.app = express();
    this.app.use(express.json());

    // Serve static dashboard
    this.app.get('/', (_req, res) => {
      res.send(this.getDashboardHTML());
    });

    // REST API endpoints
    this.setupRoutes();

    // HTTP + WS server
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      this.logger.debug('Dashboard client connected');
      // Send initial state
      ws.send(JSON.stringify(this.getFullState()));
    });

    this.server.listen(port, () => {
      this.logger.info(`Dashboard running at http://localhost:${port}`);
    });
  }

  // ── Simulation state control ─────────────────────────────────────────────

  onStartRequested(cb: () => Promise<void>): void { this.startCallback = cb; }
  onStopRequested(cb: () => void): void { this.stopCallback = cb; }
  onStartAllRequested(cb: () => Promise<void>): void { this.startAllCallback = cb; }
  onStartAgentRequested(cb: (name: string) => Promise<boolean>): void { this.startAgentCallback = cb; }

  setAgentProfiles(profiles: AgentProfile[]): void {
    this.agentProfiles = profiles;
  }

  setSimulationState(state: SimulationState, runId?: string): void {
    this.simulationState = state;
    this.currentRunId = runId ?? this.currentRunId;
    this.broadcast(this.getFullState());
  }

  getSimulationState(): SimulationState {
    return this.simulationState;
  }

  stopUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private broadcast(data: object): void {
    const msg = JSON.stringify(data);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  // ── Routes ───────────────────────────────────────────────────────────────

  private setupRoutes(): void {
    this.app.get('/api/state', (_req, res) => {
      res.json(this.getFullState());
    });

    this.app.get('/api/agents', (_req, res) => {
      const agents = this.spawner.getAllAgents().map((a: SpawnedAgent) => ({
        name: a.profile.name,
        traits: a.profile.traits,
        position: a.state.perception.position,
        health: a.state.perception.health,
        food: a.state.perception.food,
        isAlive: a.state.isAlive,
        currentDecision: a.state.cognitiveDecision.reasoning,
        inventory: a.state.perception.inventory,
        goals: a.state.goals.currentGoals.filter((g: Goal) => g.active),
        moduleStats: a.runner.getModuleStats(),
      }));
      res.json(agents);
    });

    this.app.get('/api/benchmarks', (_req, res) => {
      res.json({
        latest: this.benchmarks.getLatestSnapshot(),
        history: this.benchmarks.getSnapshots(),
        snapshotCount: this.benchmarks.getSnapshots().length,
      });
    });

    this.app.get('/api/world', (_req, res) => {
      res.json(this.worldState.toJSON());
    });

    this.app.get('/api/chat', (_req, res) => {
      res.json(this.commBus.getRecentChat(100));
    });

    this.app.get('/api/llm-stats', (_req, res) => {
      res.json(this.llm.getStats());
    });

    // ── Simulation control endpoints ────────────────────────────────────────
    this.app.post('/api/start', async (_req, res) => {
      if (this.simulationState !== 'idle') {
        res.status(409).json({ error: 'Simulation is already running' });
        return;
      }
      res.json({ ok: true });
      if (this.startCallback) await this.startCallback();
    });

    this.app.post('/api/stop', (_req, res) => {
      if (this.simulationState !== 'running' && this.simulationState !== 'spawned') {
        res.status(409).json({ error: 'No simulation is running' });
        return;
      }
      res.json({ ok: true });
      if (this.stopCallback) this.stopCallback();
    });

    // ── Staged start: start all agents or a single agent ─────────────────
    this.app.post('/api/start-all-agents', async (_req, res) => {
      if (this.simulationState !== 'spawned') {
        res.status(409).json({ error: 'Agents are not in spawned state' });
        return;
      }
      res.json({ ok: true });
      if (this.startAllCallback) await this.startAllCallback();
    });

    this.app.post('/api/start-agent/:name', async (req, res) => {
      if (this.simulationState !== 'spawned' && this.simulationState !== 'running') {
        res.status(409).json({ error: 'Agents are not in spawned state' });
        return;
      }
      const name = req.params.name;
      if (this.startAgentCallback) {
        const ok = await this.startAgentCallback(name);
        if (!ok) { res.status(404).json({ error: `Agent "${name}" not found or already started` }); return; }
      }
      res.json({ ok: true, agentName: name });
    });

    // ── Past runs endpoints ─────────────────────────────────────────────────
    this.app.get('/api/runs', (_req, res) => {
      res.json(this.store.list());
    });

    this.app.get('/api/runs/:id', (req, res) => {
      const record = this.store.get(req.params.id);
      if (!record) { res.status(404).json({ error: 'Run not found' }); return; }
      res.json(record);
    });

    this.app.get('/api/runs/:id/download', (req, res) => {
      const record = this.store.get(req.params.id);
      if (!record) { res.status(404).json({ error: 'Run not found' }); return; }
      res.setHeader('Content-Disposition', `attachment; filename="sid-run-${record.id}.json"`);
      res.setHeader('Content-Type', 'application/json');
      res.json(record);
    });

    this.app.get('/api/download', (_req, res) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const agents = this.spawner.getAllAgents().map((a: SpawnedAgent) => ({
        name: a.profile.name,
        traits: a.profile.traits,
        isAlive: a.state.isAlive,
        position: a.state.perception.position,
        health: a.state.perception.health,
        food: a.state.perception.food,
        inventory: a.state.perception.inventory,
        goals: a.state.goals.currentGoals,
        shortTermMemory: a.state.memory.shortTermMemory,
        workingMemory: a.state.memory.workingMemory,
        relationships: Object.fromEntries(a.state.social.relationships),
        moduleStats: a.runner.getModuleStats(),
        lastDecision: a.state.cognitiveDecision,
      }));
      const results = {
        exportedAt: new Date().toISOString(),
        simulation: {
          durationMs: Date.now() - (this.worldState.toJSON() as any).stats?.simulationStarted,
        },
        agents,
        benchmarkHistory: this.benchmarks.getSnapshots(),
        world: this.worldState.toJSON(),
        chatLog: this.commBus.getRecentChat(1000),
        llmStats: this.llm.getStats(),
      };
      res.setHeader('Content-Disposition', `attachment; filename="sid-results-${timestamp}.json"`);
      res.setHeader('Content-Type', 'application/json');
      res.json(results);
    });

    // ── LLM provider / model switching endpoints ───────────────────────────
    this.app.get('/api/llm-config', (_req, res) => {
      const config = this.llm.getConfig();
      res.json({
        provider: this.llm.getProvider(),
        model: this.llm.getModel(),
        ollamaHost: config.ollamaHost,
        cerebrasHost: config.host,
      });
    });

    this.app.get('/api/llm-models', async (_req, res) => {
      const [cerebrasModels, ollamaModels] = await Promise.all([
        this.llm.listCerebrasModels(),
        this.llm.listOllamaModels(),
      ]);
      res.json({ cerebras: cerebrasModels, ollama: ollamaModels });
    });

    this.app.post('/api/llm-provider', (req, res) => {
      const { provider } = req.body;
      if (provider !== 'cerebras' && provider !== 'ollama') {
        res.status(400).json({ error: 'Invalid provider. Use "cerebras" or "ollama".' });
        return;
      }
      this.llm.setProvider(provider as LLMProvider);
      res.json({ ok: true, provider });
    });

    this.app.post('/api/llm-model', (req, res) => {
      const { model } = req.body;
      if (!model || typeof model !== 'string') {
        res.status(400).json({ error: 'Missing model name.' });
        return;
      }
      this.llm.setModel(model);
      res.json({ ok: true, model });
    });

    // ── Per-agent model/provider switching ─────────────────────────────────
    // Works on both spawned agents (live) and unspawned profiles (config)
    this.app.post('/api/agent-model', (req, res) => {
      const { agentName, provider, model } = req.body;
      if (!agentName || typeof agentName !== 'string') {
        res.status(400).json({ error: 'Missing agentName.' });
        return;
      }

      // Try live agent first
      const agent = this.spawner.getAgent(agentName);
      // Also find the profile in our stored list (so changes persist before spawn)
      const profile = this.agentProfiles.find(p => p.name === agentName);

      if (!agent && !profile) {
        res.status(404).json({ error: `Agent "${agentName}" not found.` });
        return;
      }

      if (provider && (provider === 'cerebras' || provider === 'ollama')) {
        if (profile) profile.provider = provider;
        if (agent) { agent.profile.provider = provider; agent.runner.getContext().agentProvider = provider; }
      }
      if (model && typeof model === 'string') {
        if (profile) profile.model = model;
        if (agent) { agent.profile.model = model; agent.runner.getContext().agentModel = model; }
      }
      const { host: newHost } = req.body;
      if (newHost !== undefined && typeof newHost === 'string') {
        if (profile) profile.host = newHost || undefined;
        if (agent) { agent.profile.host = newHost || undefined; agent.runner.getContext().agentHost = newHost || undefined; }
      }
      const effectiveProfile = agent?.profile || profile;
      res.json({ ok: true, agentName, provider: effectiveProfile?.provider, model: effectiveProfile?.model, host: effectiveProfile?.host });
    });
  }

  // ── Live Updates ─────────────────────────────────────────────────────────

  startUpdates(intervalMs: number = 2000): void {
    this.stopUpdates();
    this.updateInterval = setInterval(() => this.broadcast(this.getFullState()), intervalMs);
  }

  stop(): void {
    this.stopUpdates();
    this.wss.close();
    this.server.close();
  }

  // ── State Aggregation ────────────────────────────────────────────────────

  private getFullState(): object {
    // Build agent list: merge live spawned agents with unspawned profiles
    const spawnedMap = new Map<string, SpawnedAgent>();
    for (const a of this.spawner.getAllAgents()) spawnedMap.set(a.profile.name, a);

    // Use profiles as the canonical list so we show all agents even before spawn
    const profileList = this.agentProfiles.length > 0 ? this.agentProfiles : [];

    const agents = profileList.map(profile => {
      const spawned = spawnedMap.get(profile.name);
      if (spawned) {
        // Agent is connected to MC
        const state = spawned.runner.getState();
        return {
          name: spawned.profile.name,
          traits: spawned.profile.traits,
          provider: spawned.profile.provider || this.llm.getProvider(),
          model: spawned.profile.model || this.llm.getModel(),
          host: spawned.profile.host || '',
          connected: true,
          started: spawned.runner.isRunning(),
          position: state.perception.position
            ? { x: Math.round(state.perception.position.x), y: Math.round(state.perception.position.y), z: Math.round(state.perception.position.z) }
            : null,
          health: state.perception.health,
          food: state.perception.food,
          isAlive: state.isAlive,
          decision: state.cognitiveDecision.reasoning,
          speech: state.cognitiveDecision.speech,
          inventory: state.perception.inventory,
          inventoryCount: state.perception.inventory.reduce((s: number, i: InventoryItem) => s + i.count, 0),
          activeGoals: state.goals.currentGoals.filter((g: Goal) => g.active && !g.completed).length,
          relationships: Object.fromEntries(
            (Array.from(state.social.relationships.entries()) as [string, SocialRelationship][])
              .map(([k, v]) => [k, v.sentiment])
          ),
        };
      } else {
        // Agent is not yet connected — show profile data only
        return {
          name: profile.name,
          traits: profile.traits,
          provider: profile.provider || this.llm.getProvider(),
          model: profile.model || this.llm.getModel(),
          host: profile.host || '',
          connected: false,
          started: false,
          position: null,
          health: 0,
          food: 0,
          isAlive: false,
          decision: '',
          speech: null,
          inventory: [],
          inventoryCount: 0,
          activeGoals: 0,
          relationships: {},
        };
      }
    });

    // Also include any spawned agents not in profiles (shouldn't happen, but safety)
    for (const [name, spawned] of spawnedMap) {
      if (!profileList.find(p => p.name === name)) {
        const state = spawned.runner.getState();
        agents.push({
          name: spawned.profile.name,
          traits: spawned.profile.traits,
          provider: spawned.profile.provider || this.llm.getProvider(),
          model: spawned.profile.model || this.llm.getModel(),
          host: spawned.profile.host || '',
          connected: true,
          started: spawned.runner.isRunning(),
          position: state.perception.position
            ? { x: Math.round(state.perception.position.x), y: Math.round(state.perception.position.y), z: Math.round(state.perception.position.z) }
            : null,
          health: state.perception.health,
          food: state.perception.food,
          isAlive: state.isAlive,
          decision: state.cognitiveDecision.reasoning,
          speech: state.cognitiveDecision.speech,
          inventory: state.perception.inventory,
          inventoryCount: state.perception.inventory.reduce((s: number, i: InventoryItem) => s + i.count, 0),
          activeGoals: state.goals.currentGoals.filter((g: Goal) => g.active && !g.completed).length,
          relationships: Object.fromEntries(
            (Array.from(state.social.relationships.entries()) as [string, SocialRelationship][])
              .map(([k, v]) => [k, v.sentiment])
          ),
        });
      }
    }

    return {
      timestamp: Date.now(),
      simulationState: this.simulationState,
      currentRunId: this.currentRunId,
      agentCount: agents.length,
      agents,
      recentChat: this.commBus.getRecentChat(20),
      benchmark: this.benchmarks.getLatestSnapshot(),
      constitution: this.worldState.getConstitutionText(),
      llmStats: this.llm.getStats(),
    };
  }

  // ── Dashboard HTML ───────────────────────────────────────────────────────

  private getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project Sid — Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0a0a; color: #e0e0e0; }
    .header { padding: 14px 24px; background: #111; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
    .header h1 { font-size: 17px; color: #4fc3f7; white-space: nowrap; }
    .header-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .stats { font-size: 12px; color: #888; }
    .pill { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; }
    .pill-idle    { background: #2a2a2a; color: #888; }
    .pill-starting{ background: #1e3a1e; color: #81c784; }
    .pill-spawned { background: #1e2a3e; color: #4fc3f7; border: 1px solid #4fc3f7; }
    .pill-running { background: #1a3a1a; color: #4caf50; border: 1px solid #4caf50; }
    .pill-stopping{ background: #3a1a1a; color: #ef9a9a; }
    .btn { padding: 6px 16px; border-radius: 5px; font-size: 12px; font-family: inherit; cursor: pointer; border: 1px solid transparent; transition: opacity .15s; }
    .btn:disabled { opacity: .4; cursor: default; }
    .btn-start { background: #1e3a1e; color: #81c784; border-color: #4caf50; }
    .btn-stop  { background: #3a1a1a; color: #ef9a9a; border-color: #e57373; }
    .btn-dl    { background: #1e3a5f; color: #4fc3f7; border-color: #4fc3f7; text-decoration: none; display: inline-flex; align-items: center; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; }
    .panel { background: #151515; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; overflow: auto; max-height: 400px; }
    .panel h2 { font-size: 13px; color: #4fc3f7; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
    .agent-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px; padding: 10px; margin-bottom: 8px; cursor: pointer; transition: border-color .15s; }
    .agent-card:hover { border-color: #4fc3f7; }
    .agent-card .name { color: #81c784; font-weight: bold; }
    .agent-card .meta { font-size: 11px; color: #888; margin-top: 4px; }
    .agent-card .decision { font-size: 11px; color: #aaa; margin-top: 4px; font-style: italic; }
    .inventory-panel { display: none; margin-top: 8px; padding: 8px; background: #111; border-radius: 4px; border: 1px solid #222; }
    .agent-card.expanded .inventory-panel { display: block; }
    .inv-header { font-size: 10px; color: #4fc3f7; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
    .inv-grid { display: flex; flex-wrap: wrap; gap: 4px; }
    .inv-item { font-size: 11px; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 4px; padding: 3px 8px; white-space: nowrap; }
    .inv-item .inv-name { color: #81c784; }
    .inv-item .inv-count { color: #888; margin-left: 4px; }
    .inv-empty { font-size: 11px; color: #555; font-style: italic; }
    .chat-entry { font-size: 12px; margin-bottom: 4px; }
    .chat-entry .sender { color: #ffb74d; font-weight: bold; }
    .chat-entry .msg { color: #ccc; }
    .metric { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; border-bottom: 1px solid #1a1a1a; }
    .metric .label { color: #888; }
    .metric .value { color: #81c784; font-weight: bold; }
    .bar { height: 6px; background: #2a2a2a; border-radius: 3px; margin-top: 4px; }
    .bar-fill { height: 100%; border-radius: 3px; background: #4fc3f7; transition: width 0.3s; }
    .full-width { grid-column: 1 / -1; }
    .constitution { font-size: 11px; white-space: pre-wrap; color: #aaa; line-height: 1.6; }
    #map { width: 100%; height: 300px; position: relative; background: #0d1117; border-radius: 4px; }
    .map-dot { position: absolute; width: 8px; height: 8px; border-radius: 50%; background: #81c784; transform: translate(-50%, -50%); }
    .map-dot .tooltip { display: none; position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); background: #222; padding: 4px 8px; border-radius: 4px; font-size: 10px; white-space: nowrap; }
    .map-dot:hover .tooltip { display: block; }
    /* Idle splash */
    #idleSplash { display:none; position:fixed; inset:0; background:#0a0a0a; z-index:100; flex-direction:column; overflow:hidden; }
    #splashHeader { padding:20px 32px; border-bottom:1px solid #222; display:flex; align-items:center; gap:12px; }
    #splashHeader h2 { color:#4fc3f7; font-size:18px; flex:1; }
    #splashHeader p { color:#666; font-size:12px; }
    #splashBody { display:flex; flex:1; overflow:hidden; }
    #splashLeft { width:320px; flex-shrink:0; border-right:1px solid #222; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px; padding:32px; }
    #splashLeft p { color:#888; font-size:12px; text-align:center; line-height:1.7; }
    #splashLeft .btn-start-big { padding:12px 36px; font-size:15px; border-radius:8px; background:#1e3a1e; color:#81c784; border:1px solid #4caf50; font-family:inherit; cursor:pointer; width:100%; }
    #splashLeft .btn-start-big:disabled { opacity:.4; cursor:default; }
    #splashStatus { color:#888; font-size:12px; }
    #splashRight { flex:1; display:flex; flex-direction:column; overflow:hidden; padding:24px 28px; }
    #splashRight h3 { color:#4fc3f7; font-size:13px; text-transform:uppercase; letter-spacing:1px; margin-bottom:16px; }
    #splashRunsList { flex:1; overflow-y:auto; }
    /* Runs list */
    .run-row { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #1a1a1a; font-size:12px; gap:8px; }
    .run-row .run-id { color:#4fc3f7; font-size:11px; }
    .run-row .run-meta { color:#888; font-size:11px; margin-top:2px; }
    .run-row a { color:#4fc3f7; font-size:11px; text-decoration:none; border:1px solid #4fc3f7; padding:2px 8px; border-radius:4px; white-space:nowrap; }
    .run-row a:hover { background:#1e3a5f; }
    #noRuns { color:#555; font-size:12px; }
    /* Run detail modal */
    #runModal { display:none; position:fixed; inset:0; z-index:200; background:rgba(0,0,0,.75); backdrop-filter:blur(4px); align-items:center; justify-content:center; }
    #runModal.open { display:flex; }
    #runModalBox { background:#111; border:1px solid #333; border-radius:10px; width:min(900px,95vw); max-height:90vh; display:flex; flex-direction:column; overflow:hidden; }
    #runModalHead { padding:16px 20px; border-bottom:1px solid #222; display:flex; align-items:flex-start; gap:12px; }
    #runModalHead .modal-title { flex:1; }
    #runModalHead .modal-title h3 { color:#4fc3f7; font-size:15px; margin-bottom:4px; }
    #runModalHead .modal-title p  { color:#666; font-size:11px; }
    #runModalHead .modal-actions { display:flex; gap:8px; align-items:center; }
    #runModalClose { background:none; border:1px solid #444; color:#aaa; border-radius:5px; padding:5px 12px; font-family:inherit; font-size:12px; cursor:pointer; }
    #runModalClose:hover { background:#222; }
    .modal-dl { color:#4fc3f7; font-size:11px; text-decoration:none; border:1px solid #4fc3f7; padding:5px 12px; border-radius:5px; white-space:nowrap; }
    .modal-dl:hover { background:#1e3a5f; }
    .modal-tabs { display:flex; gap:0; border-bottom:1px solid #222; }
    .modal-tab { padding:8px 18px; font-size:12px; font-family:inherit; background:none; border:none; color:#666; cursor:pointer; border-bottom:2px solid transparent; }
    .modal-tab.active { color:#4fc3f7; border-bottom-color:#4fc3f7; }
    .modal-tab:hover:not(.active) { color:#aaa; }
    .modal-body { flex:1; overflow-y:auto; padding:20px; }
    .modal-section { margin-bottom:24px; }
    .modal-section h4 { color:#4fc3f7; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; }
    .modal-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .modal-grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; }
    .modal-kv { background:#1a1a1a; border-radius:6px; padding:10px 14px; }
    .modal-kv .k { font-size:10px; color:#666; text-transform:uppercase; letter-spacing:.5px; margin-bottom:3px; }
    .modal-kv .v { font-size:13px; color:#e0e0e0; font-weight:bold; }
    .modal-agent { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:6px; padding:12px; }
    .modal-agent .a-name { color:#81c784; font-weight:bold; font-size:13px; margin-bottom:6px; }
    .modal-agent .a-trait { display:inline-block; background:#1e3a1e; color:#81c784; font-size:10px; padding:2px 7px; border-radius:10px; margin:2px 2px 0 0; }
    .modal-agent .a-row { font-size:11px; color:#888; margin-top:4px; }
    .modal-agent .a-row span { color:#ccc; }
    .modal-chat { font-size:12px; margin-bottom:5px; }
    .modal-chat .mc-sender { color:#ffb74d; font-weight:bold; }
    .modal-chat .mc-time { color:#555; font-size:10px; margin-left:6px; }
    .modal-pretext { font-size:11px; white-space:pre-wrap; color:#aaa; line-height:1.7; background:#0d1117; border-radius:6px; padding:14px; }
    .modal-bench-hist { display:flex; flex-direction:column; gap:4px; }
    .modal-bench-row { display:flex; gap:8px; font-size:11px; padding:5px 0; border-bottom:1px solid #1a1a1a; }
    .modal-bench-row .bh-t { color:#555; width:160px; flex-shrink:0; }
    .modal-bench-row .bh-v { color:#81c784; }
    /* LLM selector styles */
    .llm-selectors { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .llm-selectors label { font-size:11px; color:#888; }
    .llm-selectors select { background:#1a1a1a; color:#e0e0e0; border:1px solid #333; border-radius:4px; padding:4px 8px; font-size:11px; font-family:inherit; cursor:pointer; outline:none; }
    .llm-selectors select:focus { border-color:#4fc3f7; }
    .llm-selectors select option { background:#1a1a1a; color:#e0e0e0; }
    .llm-badge { font-size:10px; padding:2px 8px; border-radius:10px; background:#1e3a5f; color:#4fc3f7; white-space:nowrap; }
    /* Spawned state panel */
    #spawnedPanel { display:none; position:fixed; inset:0; background:#0a0a0a; z-index:90; flex-direction:column; overflow:hidden; }
    #spawnedPanel.visible { display:flex; }
    #spawnedHeader { padding:16px 24px; border-bottom:1px solid #222; display:flex; align-items:center; gap:16px; }
    #spawnedHeader h2 { color:#4fc3f7; font-size:17px; flex:1; }
    .btn-start-all { padding:10px 28px; font-size:14px; border-radius:7px; background:#1e3a1e; color:#81c784; border:1px solid #4caf50; font-family:inherit; cursor:pointer; }
    .btn-start-all:hover { background:#2e4a2e; }
    .btn-start-single { padding:5px 14px; font-size:11px; border-radius:5px; background:#1e3a1e; color:#81c784; border:1px solid #4caf50; font-family:inherit; cursor:pointer; white-space:nowrap; }
    .btn-start-single:hover { background:#2e4a2e; }
    .btn-start-single:disabled { opacity:.4; cursor:default; }
    .btn-start-single.started { background:#1a1a1a; color:#4caf50; border-color:#333; cursor:default; }
    #spawnedBody { flex:1; overflow-y:auto; padding:24px; display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:16px; align-content:start; }
    .spawn-card { background:#151515; border:1px solid #2a2a2a; border-radius:8px; padding:16px; display:flex; flex-direction:column; gap:10px; }
    .spawn-card .sc-header { display:flex; align-items:center; gap:10px; }
    .spawn-card .sc-name { font-size:15px; font-weight:bold; color:#81c784; flex:1; }
    .spawn-card .sc-status { font-size:10px; padding:2px 8px; border-radius:10px; }
    .spawn-card .sc-status.spawned { background:#1e2a3e; color:#4fc3f7; }
    .spawn-card .sc-status.running { background:#1a3a1a; color:#4caf50; }
    .spawn-card .sc-traits { font-size:11px; color:#888; }
    .spawn-card .sc-row { display:flex; gap:8px; align-items:center; }
    .spawn-card .sc-row label { font-size:11px; color:#888; min-width:55px; }
    .spawn-card .sc-row select, .spawn-card .sc-row input { background:#1a1a1a; color:#e0e0e0; border:1px solid #333; border-radius:4px; padding:4px 8px; font-size:11px; font-family:inherit; flex:1; min-width:0; }
    .spawn-card .sc-row select:focus, .spawn-card .sc-row input:focus { border-color:#4fc3f7; outline:none; }
    .spawn-card .sc-actions { display:flex; justify-content:flex-end; margin-top:4px; }
  </style>
</head>
<body>
  <!-- Run detail modal -->
  <div id="runModal">
    <div id="runModalBox">
      <div id="runModalHead">
        <div class="modal-title">
          <h3 id="runModalTitle">Run details</h3>
          <p id="runModalSubtitle"></p>
        </div>
        <div class="modal-actions">
          <a class="modal-dl" id="runModalDl" href="#" download>⬇ Download JSON</a>
          <button id="runModalClose" onclick="closeRunModal()">✕ Close</button>
        </div>
      </div>
      <div class="modal-tabs">
        <button class="modal-tab active" onclick="switchTab('overview')">Overview</button>
        <button class="modal-tab" onclick="switchTab('agents')">Agents</button>
        <button class="modal-tab" onclick="switchTab('chat')">Chat Log</button>
        <button class="modal-tab" onclick="switchTab('constitution')">Constitution</button>
        <button class="modal-tab" onclick="switchTab('history')">Benchmark History</button>
      </div>
      <div class="modal-body" id="runModalBody"></div>
    </div>
  </div>

  <!-- Idle splash shown when no simulation is running -->
  <div id="idleSplash">
    <div id="splashHeader">
      <h2>Project Sid</h2>
      <p>AI Civilization Simulation — PIANO Architecture</p>
    </div>
    <div id="splashBody">
      <div id="splashLeft">
        <p>Start a new simulation run when your Minecraft server is ready.</p>        <div class="llm-selectors" style="flex-direction:column;width:100%;gap:6px;">
          <div style="display:flex;gap:8px;align-items:center;width:100%;">
            <label>Provider:</label>
            <select id="splashProviderSelect" onchange="switchProvider(this.value)" style="flex:1;">
              <option value="cerebras">Cerebras</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>
          <div style="display:flex;gap:8px;align-items:center;width:100%;">
            <label>Model:</label>
            <select id="splashModelSelect" onchange="switchModel(this.value)" style="flex:1;"></select>
          </div>
          <span class="llm-badge" id="splashLlmBadge" style="align-self:flex-start;">cerebras / gpt-oss-120b</span>
        </div>        <button class="btn-start-big" id="splashStartBtn">▶ Start Simulation</button>
        <div id="splashStatus"></div>
      </div>
      <div id="splashRight">
        <h3>Past Runs</h3>
        <div id="splashRunsList"><div id="noRuns">No runs saved yet.</div></div>
      </div>
    </div>
  </div>

  <!-- Spawned panel: agents connected but AI not running yet -->
  <div id="spawnedPanel">
    <div id="spawnedHeader">
      <h2>Agents Spawned — Configure &amp; Start</h2>
      <span class="pill pill-spawned">spawned</span>
      <button class="btn-start-all" id="startAllBtn" onclick="startAllAgents()">▶ Start All Agents</button>
      <button class="btn btn-stop" onclick="stopSim()">■ Stop</button>
    </div>
    <div id="spawnedBody"></div>
  </div>

  <div class="header">
    <h1>Project Sid — Simulation Dashboard</h1>
    <div class="header-right">
      <div class="llm-selectors">
        <label>Provider:</label>
        <select id="providerSelect" onchange="switchProvider(this.value)">
          <option value="cerebras">Cerebras</option>
          <option value="ollama">Ollama</option>
        </select>
        <label>Model:</label>
        <select id="modelSelect" onchange="switchModel(this.value)"></select>
        <span class="llm-badge" id="llmBadge">cerebras / gpt-oss-120b</span>
      </div>
      <span class="pill pill-idle" id="statePill">idle</span>
      <span class="stats" id="headerStats"></span>
      <button class="btn btn-start" id="startBtn" onclick="startSim()">▶ Start</button>
      <button class="btn btn-stop"  id="stopBtn"  onclick="stopSim()" disabled>■ Stop</button>
      <a class="btn btn-dl" id="dlBtn" href="/api/download">⬇ Export</a>
    </div>
  </div>

  <div class="grid">
    <div class="panel">
      <h2>Agent Map</h2>
      <div id="map"></div>
    </div>
    <div class="panel">
      <h2>Agents</h2>
      <div id="agentList"></div>
    </div>
    <div class="panel">
      <h2>Chat Log</h2>
      <div id="chatLog"></div>
    </div>
    <div class="panel">
      <h2>Benchmarks</h2>
      <div id="benchmarks"></div>
    </div>
    <div class="panel">
      <h2>Social Graph</h2>
      <div id="socialGraph"></div>
    </div>
    <div class="panel">
      <h2>LLM Stats</h2>
      <div id="llmStats"></div>
    </div>
    <div class="panel full-width">
      <h2>Constitution</h2>
      <div id="constitution" class="constitution"></div>
    </div>
    <div class="panel full-width">
      <h2>Past Runs</h2>
      <div id="runsList"><div id="noRuns">No runs saved yet.</div></div>
    </div>
  </div>

  <script>
    const ws = new WebSocket('ws://' + location.host);
    let lastState = 'idle';

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      updateDashboard(data);
    };
    ws.onopen = () => {
      loadRuns();
    };
    ws.onclose = () => {
      document.getElementById('headerStats').textContent = 'Disconnected';
    };

    // ── Incremental update: skip rebuilding panels that contain focused inputs ──
    function _elFocused(container) {
      if (!container) return false;
      const a = document.activeElement;
      return a && container.contains(a) && (a.tagName === 'SELECT' || a.tagName === 'INPUT');
    }

    function _flashSaved(el) {
      if (!el) return;
      el.style.borderColor = '#4caf50';
      el.style.boxShadow = '0 0 6px rgba(76,175,80,.3)';
      setTimeout(() => { el.style.borderColor = ''; el.style.boxShadow = ''; }, 1200);
    }

    function setUiState(state) {
      lastState = state;
      const pill = document.getElementById('statePill');
      pill.textContent = state;
      pill.className = 'pill pill-' + state;
      const startBtn = document.getElementById('startBtn');
      const stopBtn  = document.getElementById('stopBtn');
      startBtn.disabled = state !== 'idle';
      stopBtn.disabled  = state !== 'running' && state !== 'spawned';
      // Toggle idle splash
      const splash = document.getElementById('idleSplash');
      splash.style.display = state === 'idle' ? 'flex' : 'none';
      // Toggle spawned panel
      const spawnedPanel = document.getElementById('spawnedPanel');
      if (state === 'spawned') { spawnedPanel.classList.add('visible'); }
      else { spawnedPanel.classList.remove('visible'); }
      // Reload runs list after a run ends
      if (state === 'idle') loadRuns();
    }

    async function startSim() {
      document.getElementById('splashStatus').textContent = 'Starting…';
      document.getElementById('splashStartBtn').disabled = true;
      document.getElementById('startBtn').disabled = true;
      await fetch('/api/start', { method: 'POST' });
    }
    async function stopSim() {
      document.getElementById('stopBtn').disabled = true;
      await fetch('/api/stop', { method: 'POST' });
    }

    function buildRunRows(runs) {
      if (!runs.length) return '<div id="noRuns">No runs saved yet.</div>';
      return runs.map(r => {
        const started = new Date(r.startedAt).toLocaleString();
        const dur = r.durationMs ? (r.durationMs / 60000).toFixed(1) + ' min' : 'in progress';
        const tier = r.finalBenchmark?.progression?.maxTier ?? '—';
        const entropy = r.finalBenchmark?.specialization?.normalizedEntropy != null
          ? r.finalBenchmark.specialization.normalizedEntropy.toFixed(2) : '—';
        const safeId = r.id.replace(/"/g, '&quot;');
        return \`<div class="run-row" style="cursor:pointer" onclick="openRunModal('\${safeId}')">
          <div>
            <div class="run-id">\${r.id}</div>
            <div class="run-meta">\${started} &nbsp;|&nbsp; \${dur} &nbsp;|&nbsp; \${(r.agentNames||[]).join(', ')} &nbsp;|&nbsp; Tier: \${tier} &nbsp;|&nbsp; Entropy: \${entropy}</div>
          </div>
          <a href="/api/runs/\${encodeURIComponent(r.id)}/download" download onclick="event.stopPropagation()">⬇ Download</a>
        </div>\`;
      }).join('');
    }

    // ── Run detail modal ──────────────────────────────────────────
    let _modalRun = null;
    let _activeTab = 'overview';

    async function openRunModal(id) {
      document.getElementById('runModalBody').innerHTML = '<div style="color:#555;padding:20px">Loading…</div>';
      document.getElementById('runModal').classList.add('open');
      try {
        const run = await fetch('/api/runs/' + encodeURIComponent(id)).then(r => r.json());
        _modalRun = run;
        _activeTab = 'overview';
        document.querySelectorAll('.modal-tab').forEach((t,i) => t.classList.toggle('active', i===0));
        const started = new Date(run.startedAt).toLocaleString();
        const ended   = run.endedAt ? new Date(run.endedAt).toLocaleString() : 'in progress';
        const dur = run.durationMs ? (run.durationMs / 60000).toFixed(1) + ' min' : 'in progress';
        document.getElementById('runModalTitle').textContent = run.id;
        document.getElementById('runModalSubtitle').textContent = started + '  →  ' + ended + '  (' + dur + ')  ·  ' + (run.agentNames||[]).join(', ');
        document.getElementById('runModalDl').href = '/api/runs/' + encodeURIComponent(id) + '/download';
        renderTab('overview');
      } catch(e) {
        document.getElementById('runModalBody').innerHTML = '<div style="color:#e57373;padding:20px">Failed to load run data.</div>';
      }
    }

    function closeRunModal() {
      document.getElementById('runModal').classList.remove('open');
      _modalRun = null;
    }

    // Close on backdrop click
    document.getElementById('runModal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('runModal')) closeRunModal();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRunModal(); });

    function switchTab(name) {
      _activeTab = name;
      document.querySelectorAll('.modal-tab').forEach(t => {
        t.classList.toggle('active', t.textContent.toLowerCase().startsWith(name) || t.getAttribute('onclick').includes(name));
      });
      renderTab(name);
    }

    function m(k, v) { return \`<div class="modal-kv"><div class="k">\${k}</div><div class="v">\${v}</div></div>\`; }

    function renderTab(tab) {
      const run = _modalRun;
      if (!run) return;
      const body = document.getElementById('runModalBody');
      const b = run.finalBenchmark;

      if (tab === 'overview') {
        const dur = run.durationMs ? (run.durationMs / 60000).toFixed(1) + ' min' : 'N/A';
        body.innerHTML = \`
          <div class="modal-section">
            <h4>Run Info</h4>
            <div class="modal-grid3">
              \${m('Duration', dur)}
              \${m('Agents', (run.agentNames||[]).join(', ') || 'N/A')}
              \${m('Server', run.config?.server?.host || 'N/A')}
            </div>
          </div>
          <div class="modal-section">
            <h4>Final Benchmarks</h4>
            \${b ? \`<div class="modal-grid3">
              \${m('Max Progression Tier', b.progression?.maxTier ?? '—')}
              \${m('Avg Tier', b.progression?.avgTier?.toFixed(2) ?? '—')}
              \${m('Specialization Entropy', b.specialization?.normalizedEntropy?.toFixed(4) ?? '—')}
              \${m('Role Distribution', JSON.stringify(b.specialization?.roleDistribution ?? {}))}
              \${m('Tax Compliance Rate', b.collectiveRules?.complianceRate?.toFixed(3) ?? '—')}
              \${m('Amendments Passed', b.collectiveRules?.passedAmendments ?? '—')}
              \${m('Amendments Rejected', b.collectiveRules?.rejectedAmendments ?? '—')}
              \${m('Meme Diversity', b.culturalTransmission?.memeDiversity?.toFixed(4) ?? '—')}
              \${m('Avg Meme Spread', b.culturalTransmission?.averageSpread?.toFixed(4) ?? '—')}
            </div>\` : '<div style="color:#555;font-size:12px">No benchmark data.</div>'}
          </div>
          <div class="modal-section">
            <h4>LLM Stats</h4>
            \${run.llmStats ? \`<div class="modal-grid3">
              \${m('Total Calls', run.llmStats.totalCalls)}
              \${m('Total Tokens', (run.llmStats.totalTokens||0).toLocaleString())}
              \${m('Avg Tokens/Call', run.llmStats.avgTokensPerCall)}
              \${m('Avg Latency', (run.llmStats.avgDurationMs||0) + 'ms')}
              \${m('Retries', run.llmStats.retries ?? '—')}
              \${m('Errors', run.llmStats.errors ?? '—')}
            </div>\` : '<div style="color:#555;font-size:12px">No LLM stats.</div>'}
          </div>
        \`;

      } else if (tab === 'agents') {
        const cards = (run.agents || []).map(a => \`
          <div class="modal-agent">
            <div class="a-name">\${a.name} \${a.isAlive ? '🟢' : '🔴'}</div>
            <div>\${(a.traits||[]).map(t => \`<span class="a-trait">\${t}</span>\`).join('')}</div>
            <div class="a-row">HP: <span>\${a.health ?? '?'}/20</span>  Food: <span>\${a.food ?? '?'}/20</span>  Inventory: <span>\${(a.inventory||[]).length} items</span></div>
            \${a.position ? \`<div class="a-row">Position: <span>(\${a.position.x}, \${a.position.y}, \${a.position.z})</span></div>\` : ''}
            \${a.goals?.length ? \`<div class="a-row">Goals: <span>\${a.goals.join('; ')}</span></div>\` : ''}
            \${a.lastDecision ? \`<div class="a-row">Last decision: <span>\${a.lastDecision}</span></div>\` : ''}
            \${Object.keys(a.relationships||{}).length ? \`<div class="a-row">Relationships: <span>\${Object.entries(a.relationships).map(([k,v]) => k+': '+v).join(', ')}</span></div>\` : ''}
          </div>
        \`).join('');
        body.innerHTML = \`<div class="modal-grid2">\${cards || '<div style="color:#555">No agent data.</div>'}</div>\`;

      } else if (tab === 'chat') {
        const lines = (run.chatLog || []).map(c => {
          const t = c.timestamp ? '<span class="mc-time">' + new Date(c.timestamp).toLocaleTimeString() + '</span>' : '';
          return \`<div class="modal-chat"><span class="mc-sender">\${c.sender}:</span> \${c.message}\${t}</div>\`;
        }).join('');
        body.innerHTML = lines || '<div style="color:#555;font-size:12px">No chat messages recorded.</div>';

      } else if (tab === 'constitution') {
        const c = run.world?.constitution;
        let text = '';
        if (c && typeof c === 'object') {
          text = (c.preamble || '') + '\\n\\n';
          (c.articles || []).forEach((a, i) => {
            text += 'Article ' + (i+1) + ': ' + (a.title || '') + '\\n' + (a.content || '') + '\\n\\n';
          });
          const passed = (c.amendments || []).filter(a => a.passed);
          if (passed.length) {
            text += 'Amendments:\\n';
            passed.forEach((a, i) => { text += (i+1) + '. ' + a.description + '\\n'; });
          }
        } else if (typeof c === 'string') {
          text = c;
        }
        body.innerHTML = text
          ? \`<pre class="modal-pretext">\${text.trim()}</pre>\`
          : '<div style="color:#555;font-size:12px">No constitution data.</div>';

      } else if (tab === 'history') {
        const snaps = run.benchmarkHistory || [];
        if (!snaps.length) { body.innerHTML = '<div style="color:#555;font-size:12px">No history snapshots recorded.</div>'; return; }
        const rows = snaps.map(s => \`
          <div class="modal-bench-row">
            <span class="bh-t">\${new Date(s.timestamp).toLocaleTimeString()}</span>
            <span class="bh-v">Tier \${s.progression?.maxTier ?? '—'}</span>
            <span class="bh-v">Entropy \${s.specialization?.normalizedEntropy?.toFixed(3) ?? '—'}</span>
            <span class="bh-v">Compliance \${s.collectiveRules?.complianceRate?.toFixed(2) ?? '—'}</span>
            <span class="bh-v">Meme spread \${s.culturalTransmission?.averageSpread?.toFixed(3) ?? '—'}</span>
          </div>
        \`).join('');
        body.innerHTML = \`<div class="modal-bench-hist">\${rows}</div>\`;
      }
    }

    async function loadRuns() {
      try {
        const runs = await fetch('/api/runs').then(r => r.json());
        const html = buildRunRows(runs);
        const splashEl = document.getElementById('splashRunsList');
        const mainEl   = document.getElementById('runsList');
        if (splashEl) splashEl.innerHTML = html;
        if (mainEl)   mainEl.innerHTML   = html;
      } catch { /* ignore */ }
    }

    function updateDashboard(data) {
      setUiState(data.simulationState || 'idle');

      // Render spawned panel agent cards
      if (data.simulationState === 'spawned' || data.simulationState === 'running') {
        const spawnedBody = document.getElementById('spawnedBody');
        if (spawnedBody && data.simulationState === 'spawned' && !_elFocused(spawnedBody)) {
          spawnedBody.innerHTML = (data.agents || []).map(a => {
            const safeName = a.name.replace(/"/g, '&quot;');
            const isConnected = a.connected;
            const isStarted = a.started;
            // Status: NOT CONNECTED → CONNECTING → RUNNING
            let statusClass, statusText, btnClass, btnText, btnDisabled;
            if (isStarted) {
              statusClass = 'running'; statusText = 'RUNNING';
              btnClass = 'btn-start-single started'; btnText = '✓ Running'; btnDisabled = true;
            } else if (isConnected) {
              statusClass = 'running'; statusText = 'CONNECTED';
              btnClass = 'btn-start-single started'; btnText = '✓ Connected'; btnDisabled = true;
            } else {
              statusClass = 'spawned'; statusText = 'READY';
              btnClass = 'btn-start-single'; btnText = '▶ Start'; btnDisabled = false;
            }
            const traits = (a.traits || []).join(', ');
            // Disable config controls once the agent is already connected
            const configDisabled = isConnected ? 'disabled' : '';
            return \`
            <div class="spawn-card" data-agent="\${safeName}">
              <div class="sc-header">
                <span class="sc-name">\${a.name}</span>
                <span class="sc-status \${statusClass}">\${statusText}</span>
              </div>
              <div class="sc-traits">\${traits}</div>
              <div class="sc-row">
                <label>Provider:</label>
                <select class="sc-prov" onchange="switchSpawnProvider('\${safeName}',this.value,this)" \${configDisabled}>
                  <option value="cerebras" \${a.provider==='cerebras'?'selected':''}>Cerebras</option>
                  <option value="ollama" \${a.provider==='ollama'?'selected':''}>Ollama</option>
                </select>
              </div>
              <div class="sc-row">
                <label>Model:</label>
                <select class="spawn-model-sel" data-agent="\${safeName}" onchange="switchSpawnModel('\${safeName}',this.value,this)" \${configDisabled}>
                  <option value="\${a.model || ''}" selected>\${a.model || '(loading…)'}</option>
                </select>
              </div>
              <div class="sc-row">
                <label>Host:</label>
                <input type="text" class="spawn-host-input" data-agent="\${safeName}" value="\${a.host || ''}" placeholder="default (use global)" onchange="switchSpawnHost('\${safeName}',this.value,this)" \${configDisabled} />
              </div>
              \${a.position ? \`<div class="sc-traits">Position: (\${a.position.x}, \${a.position.y}, \${a.position.z}) | HP: \${a.health}/20</div>\` : ''}
              <div class="sc-actions">
                <button class="\${btnClass}" onclick="startSingleAgent('\${safeName}')" \${btnDisabled ? 'disabled' : ''}>\${btnText}</button>
              </div>
            </div>\`;
          }).join('');
          // Populate model selects for spawn cards
          document.querySelectorAll('.spawn-model-sel').forEach(sel => {
            const agentName = sel.getAttribute('data-agent');
            const agentData = (data.agents || []).find(a => a.name === agentName);
            if (!agentData) return;
            const prov = agentData.provider || 'ollama';
            const models = prov === 'cerebras' ? _allModels.cerebras : _allModels.ollama;
            sel.innerHTML = models.map(m => '<option value="' + m + '"' + (m === agentData.model ? ' selected' : '') + '>' + m + '</option>').join('');
          });
        }
      }

      document.getElementById('headerStats').textContent =
        data.simulationState === 'running'
          ? \`Run: \${data.currentRunId || ''} | Agents: \${data.agentCount} | LLM calls: \${data.llmStats?.totalCalls || 0} | Tokens: \${(data.llmStats?.totalTokens || 0).toLocaleString()}\`
          : '';

      // Agent list — skip full rebuild while user is editing model selects
      const agentList = document.getElementById('agentList');
      if (!_elFocused(agentList)) {
      agentList.innerHTML = (data.agents || []).map(a => {
        const invItems = (a.inventory || []).map(i =>
          \`<span class="inv-item"><span class="inv-name">\${i.name.replace(/_/g,' ')}</span><span class="inv-count">\u00d7\${i.count}</span></span>\`
        ).join('');
        const invPanel = invItems
          ? \`<div class="inv-header">Inventory (\${a.inventoryCount} items)</div><div class="inv-grid">\${invItems}</div>\`
          : \`<div class="inv-empty">Empty inventory</div>\`;
        const safeName = a.name.replace(/"/g, '&quot;');
        const modelBadge = \`<span class="llm-badge" style="margin-left:8px;font-size:9px">\${a.provider}/\${a.model}</span>\`;
        const modelPanel = \`<div class="agent-model-panel" style="margin-top:8px;padding-top:8px;border-top:1px solid #222;">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <label style="font-size:10px;color:#888;">Provider:</label>
            <select class="agent-provider-sel" data-agent="\${safeName}" onchange="switchAgentProvider('\${safeName}',this.value,this)" style="background:#1a1a1a;color:#e0e0e0;border:1px solid #333;border-radius:3px;padding:2px 6px;font-size:10px;font-family:inherit;">
              <option value="cerebras" \${a.provider==='cerebras'?'selected':''}>Cerebras</option>
              <option value="ollama" \${a.provider==='ollama'?'selected':''}>Ollama</option>
            </select>
            <label style="font-size:10px;color:#888;">Model:</label>
            <select class="agent-model-sel" data-agent="\${safeName}" onchange="switchAgentModel('\${safeName}',this.value,this)" style="background:#1a1a1a;color:#e0e0e0;border:1px solid #333;border-radius:3px;padding:2px 6px;font-size:10px;font-family:inherit;max-width:180px;">
              <option value="\${a.model || ''}" selected>\${a.model || '?'}</option>
            </select>
          </div>
        </div>\`;
        return \`
        <div class="agent-card" onclick="if(event.target.tagName!=='SELECT')this.classList.toggle('expanded')" data-agent-name="\${safeName}">
          <div class="name">\${a.name} \${a.isAlive ? '🟢' : '🔴'}\${modelBadge}</div>
          <div class="meta">
            HP: \${a.health}/20 | Food: \${a.food}/20 | Items: \${a.inventoryCount} | Goals: \${a.activeGoals}
            \${a.position ? \` | Pos: (\${a.position.x}, \${a.position.y}, \${a.position.z})\` : ''}
          </div>
          <div class="decision">\${a.decision || 'Idle'}</div>
          \${a.speech ? \`<div class="decision">💬 "\${a.speech}"</div>\` : ''}
          <div class="inventory-panel">\${invPanel}\${modelPanel}</div>
        </div>\`;
      }).join('') || '<div style="color:#555;font-size:12px">No agents spawned</div>';

      // Populate agent model selects with available models
      document.querySelectorAll('.agent-model-sel').forEach(sel => {
        const agentName = sel.getAttribute('data-agent');
        const agentData = (data.agents || []).find(a => a.name === agentName);
        if (!agentData) return;
        const prov = agentData.provider || 'ollama';
        const models = prov === 'cerebras' ? _allModels.cerebras : _allModels.ollama;
        sel.innerHTML = models.map(m => '<option value="' + m + '"' + (m === agentData.model ? ' selected' : '') + '>' + m + '</option>').join('');
      });
      }

      // Map
      const map = document.getElementById('map');
      map.innerHTML = '';
      const mapW = map.clientWidth, mapH = map.clientHeight;
      const positions = (data.agents || []).filter(a => a.position).map(a => a.position);
      if (positions.length > 0) {
        const minX = Math.min(...positions.map(p => p.x)) - 50;
        const maxX = Math.max(...positions.map(p => p.x)) + 50;
        const minZ = Math.min(...positions.map(p => p.z)) - 50;
        const maxZ = Math.max(...positions.map(p => p.z)) + 50;
        (data.agents || []).filter(a => a.position).forEach(a => {
          const dot = document.createElement('div');
          dot.className = 'map-dot';
          dot.style.left = ((a.position.x - minX) / (maxX - minX) * mapW) + 'px';
          dot.style.top  = ((a.position.z - minZ) / (maxZ - minZ) * mapH) + 'px';
          dot.innerHTML = \`<div class="tooltip">\${a.name}</div>\`;
          map.appendChild(dot);
        });
      }

      // Chat
      const chatLog = document.getElementById('chatLog');
      chatLog.innerHTML = (data.recentChat || []).slice(-20).reverse().map(c => \`
        <div class="chat-entry">
          <span class="sender">\${c.sender}:</span>
          <span class="msg">\${c.message}</span>
        </div>
      \`).join('');

      // Benchmarks
      const bench = data.benchmark;
      const benchEl = document.getElementById('benchmarks');
      benchEl.innerHTML = bench ? \`
        <div class="metric"><span class="label">Specialization Entropy</span><span class="value">\${bench.specialization?.normalizedEntropy?.toFixed(3) || 'N/A'}</span></div>
        <div class="metric"><span class="label">Role Distribution</span><span class="value">\${JSON.stringify(bench.specialization?.roleDistribution || {})}</span></div>
        <div class="metric"><span class="label">Avg Tax Compliance</span><span class="value">\${bench.collectiveRules?.complianceRate?.toFixed(2) || 0}</span></div>
        <div class="metric"><span class="label">Amendments Passed</span><span class="value">\${bench.collectiveRules?.passedAmendments || 0}</span></div>
        <div class="metric"><span class="label">Avg Meme Spread</span><span class="value">\${bench.culturalTransmission?.averageSpread?.toFixed(3) || 'N/A'}</span></div>
        <div class="metric"><span class="label">Max Progression Tier</span><span class="value">\${bench.progression?.maxTier ?? 0}</span></div>
      \` : '<div class="metric"><span class="label">Waiting for first snapshot…</span></div>';

      // Social graph
      const socialEl = document.getElementById('socialGraph');
      socialEl.innerHTML = (data.agents || []).map(a => {
        const rels = Object.entries(a.relationships || {})
          .map(([name, sent]) => \`\${name}: \${'█'.repeat(Math.max(0,Math.round(sent))).substring(0,10) || '░'} (\${sent})\`)
          .join('<br>');
        return rels ? \`<div style="margin-bottom:8px"><strong style="color:#81c784">\${a.name}</strong><br><span style="font-size:11px">\${rels}</span></div>\` : '';
      }).filter(Boolean).join('') || '<div class="metric"><span class="label">No relationships yet</span></div>';

      // LLM Stats
      const llm = data.llmStats;
      document.getElementById('llmStats').innerHTML = llm ? \`
        <div class="metric"><span class="label">Provider</span><span class="value">\${llm.provider || '?'}</span></div>
        <div class="metric"><span class="label">Model</span><span class="value">\${llm.model || '?'}</span></div>
        <div class="metric"><span class="label">Total Calls</span><span class="value">\${llm.totalCalls}</span></div>
        <div class="metric"><span class="label">Total Tokens</span><span class="value">\${llm.totalTokens.toLocaleString()}</span></div>
        <div class="metric"><span class="label">Avg Tokens/Call</span><span class="value">\${llm.avgTokensPerCall}</span></div>
        <div class="metric"><span class="label">Avg Latency</span><span class="value">\${llm.avgDurationMs}ms</span></div>
        <div class="metric"><span class="label">In-Flight</span><span class="value">\${llm.inflight}</span></div>
        <div class="metric"><span class="label">Queued</span><span class="value">\${llm.queued}</span></div>
      \` : '';

      // Update LLM badge and selects from live data
      if (llm) {
        updateLlmBadge(llm.provider, llm.model);
        syncProviderSelects(llm.provider);
      }

      // Constitution
      document.getElementById('constitution').textContent = data.constitution || '';
    }

    // Init: show splash immediately
    setUiState('idle');
    document.getElementById('splashStartBtn').addEventListener('click', startSim);

    // ── LLM provider / model switching ────────────────────────────────────
    let _allModels = { cerebras: [], ollama: [] };
    let _currentProvider = 'cerebras';
    let _currentModel = 'gpt-oss-120b';

    function updateLlmBadge(provider, model) {
      const text = provider + ' / ' + model;
      const el1 = document.getElementById('llmBadge');
      const el2 = document.getElementById('splashLlmBadge');
      if (el1) el1.textContent = text;
      if (el2) el2.textContent = text;
    }

    function syncProviderSelects(provider) {
      ['providerSelect', 'splashProviderSelect'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.value !== provider) el.value = provider;
      });
    }

    function populateModelSelects(models) {
      ['modelSelect', 'splashModelSelect'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = models.map(m => '<option value=\"' + m + '\">' + m + '</option>').join('');
        // Restore selection if still available
        if (models.includes(prev)) sel.value = prev;
        else if (models.includes(_currentModel)) sel.value = _currentModel;
      });
    }

    async function loadModels() {
      try {
        _allModels = await fetch('/api/llm-models').then(r => r.json());
        const models = _currentProvider === 'cerebras' ? _allModels.cerebras : _allModels.ollama;
        populateModelSelects(models);
      } catch(e) { console.error('Failed to load models', e); }
    }

    async function loadLlmConfig() {
      try {
        const cfg = await fetch('/api/llm-config').then(r => r.json());
        _currentProvider = cfg.provider;
        _currentModel = cfg.model;
        syncProviderSelects(cfg.provider);
        updateLlmBadge(cfg.provider, cfg.model);
        await loadModels();
        // Set model select to current
        ['modelSelect', 'splashModelSelect'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = cfg.model;
        });
      } catch(e) { console.error('Failed to load LLM config', e); }
    }

    async function switchProvider(provider) {
      _currentProvider = provider;
      syncProviderSelects(provider);
      // Update model list for this provider
      const models = provider === 'cerebras' ? _allModels.cerebras : _allModels.ollama;
      populateModelSelects(models);
      // Auto-select first model
      const firstModel = models[0] || '';
      _currentModel = firstModel;
      updateLlmBadge(provider, firstModel);
      // Push to server
      await fetch('/api/llm-provider', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({provider}) });
      if (firstModel) {
        await fetch('/api/llm-model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({model:firstModel}) });
      }
    }

    async function switchModel(model) {
      _currentModel = model;
      updateLlmBadge(_currentProvider, model);
      // Sync both selects
      ['modelSelect', 'splashModelSelect'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = model;
      });
      await fetch('/api/llm-model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({model}) });
    }

    // ── Per-agent model/provider switching ──────────────────────────────
    async function switchAgentProvider(agentName, provider, el) {
      const models = provider === 'cerebras' ? _allModels.cerebras : _allModels.ollama;
      const firstModel = models[0] || '';
      document.querySelectorAll('.agent-model-sel[data-agent="' + agentName + '"]').forEach(sel => {
        sel.innerHTML = models.map(m => '<option value="' + m + '"' + (m === firstModel ? ' selected' : '') + '>' + m + '</option>').join('');
      });
      await fetch('/api/agent-model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({agentName, provider, model: firstModel}) });
      _flashSaved(el);
    }

    async function switchAgentModel(agentName, model, el) {
      await fetch('/api/agent-model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({agentName, model}) });
      _flashSaved(el);
    }

    // ── Spawned-state controls ─────────────────────────────────────────
    async function startAllAgents() {
      document.getElementById('startAllBtn').disabled = true;
      document.getElementById('startAllBtn').textContent = 'Connecting all…';
      // Disable all individual start buttons and config controls
      document.querySelectorAll('.spawn-card .btn-start-single').forEach(btn => { btn.disabled = true; btn.textContent = 'Connecting…'; });
      document.querySelectorAll('.spawn-card select, .spawn-card input').forEach(el => el.disabled = true);
      document.querySelectorAll('.sc-status').forEach(el => { el.textContent = 'CONNECTING'; el.className = 'sc-status spawned'; });
      await fetch('/api/start-all-agents', { method: 'POST' });
    }

    async function startSingleAgent(name) {
      const card = document.querySelector('.spawn-card[data-agent="' + name + '"]');
      const btn = card ? card.querySelector('.btn-start-single') : null;
      const status = card ? card.querySelector('.sc-status') : null;
      if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
      if (status) { status.textContent = 'CONNECTING'; status.className = 'sc-status spawned'; }
      // Disable config controls immediately
      if (card) {
        card.querySelectorAll('select, input').forEach(el => el.disabled = true);
      }
      await fetch('/api/start-agent/' + encodeURIComponent(name), { method: 'POST' });
    }

    async function switchSpawnProvider(agentName, provider, el) {
      const models = provider === 'cerebras' ? _allModels.cerebras : _allModels.ollama;
      const firstModel = models[0] || '';
      document.querySelectorAll('.spawn-model-sel[data-agent="' + agentName + '"]').forEach(sel => {
        sel.innerHTML = models.map(m => '<option value="' + m + '"' + (m === firstModel ? ' selected' : '') + '>' + m + '</option>').join('');
      });
      await fetch('/api/agent-model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({agentName, provider, model: firstModel}) });
      _flashSaved(el);
    }

    async function switchSpawnModel(agentName, model, el) {
      await fetch('/api/agent-model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({agentName, model}) });
      _flashSaved(el);
    }

    async function switchSpawnHost(agentName, host, el) {
      await fetch('/api/agent-model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({agentName, host}) });
      _flashSaved(el);
    }

    // Load LLM config + models on page load
    loadLlmConfig();
  </script>
</body>
</html>`;
  }
}