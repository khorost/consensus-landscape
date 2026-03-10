import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { SimulationEngine, ActiveMessage, ClientConnection } from '../simulation/engine';
import { RaftAlgorithm } from '../simulation/algorithms/raft';
import { PaxosAlgorithm } from '../simulation/algorithms/paxos';
import { MultiPaxosAlgorithm } from '../simulation/algorithms/multi-paxos';
import { ZabAlgorithm } from '../simulation/algorithms/zab';
import { EPaxosAlgorithm } from '../simulation/algorithms/epaxos';
import { ClusterConfig, NodeId, NodeState, SimulationMetrics, LiveStats, ClientState } from '../simulation/types';
import { ConsensusAlgorithm } from '../simulation/algorithms/interface';
import {
  NETWORK_MIN_DELAY, NETWORK_MAX_DELAY,
  DEFAULT_ELECTION_TIMEOUT_MIN, DEFAULT_ELECTION_TIMEOUT_MAX, DEFAULT_HEARTBEAT_INTERVAL,
  MAX_FRAME_DELTA_MS,
  NetworkProfile, NETWORK_PROFILES,
} from '../simulation/constants';

export type AlgorithmType = 'raft' | 'paxos' | 'multi-paxos' | 'zab' | 'epaxos';

export type TimeoutProgressMap = Map<NodeId, { type: string; progress: number }[]>;

export interface SimulationState {
  time: number;
  nodes: Map<NodeId, NodeState>;
  activeMessages: ActiveMessage[];
  metrics: SimulationMetrics;
  liveStats: LiveStats;
  clients: ClientState[];
  isRunning: boolean;
  speed: number;
  timeoutProgress: TimeoutProgressMap;
  clientConnections: ClientConnection[];
  /** Next auto-client fire time per client id */
  autoClientTiming: Map<string, number>;
}

function createAlgorithm(type: AlgorithmType): ConsensusAlgorithm {
  switch (type) {
    case 'raft': return new RaftAlgorithm();
    case 'paxos': return new PaxosAlgorithm();
    case 'multi-paxos': return new MultiPaxosAlgorithm();
    case 'zab': return new ZabAlgorithm();
    case 'epaxos': return new EPaxosAlgorithm();
  }
}

const EMPTY_METRICS: SimulationMetrics = {
  commitTimestamps: [],
  commitLatencies: [],
  leaderChangeTimestamps: [],
  nodeEvents: [],
  conflictTimestamps: [],
  statusZones: [],
};

const EMPTY_LIVE_STATS: LiveStats = {
  totalMessages: 0,
  droppedMessages: 0,
  totalCommits: 0,
  leaderChanges: 0,
  avgLatency: 0,
  currentLeader: null,
  currentTerm: 0,
  electionTime: null,
  rejectedRequests: 0,
  nackCount: 0,
  quorumSize: 0,
};

const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  nodeCount: 5,
  clientCount: 2,
  observerIds: [],
  networkConfig: {
    minDelay: NETWORK_MIN_DELAY,
    maxDelay: NETWORK_MAX_DELAY,
    packetLossRate: 0,
    partitions: [],
  },
  electionTimeoutMin: DEFAULT_ELECTION_TIMEOUT_MIN,
  electionTimeoutMax: DEFAULT_ELECTION_TIMEOUT_MAX,
  heartbeatInterval: DEFAULT_HEARTBEAT_INTERVAL,
};

function snapshotNodes(nodes: Map<NodeId, NodeState>): Map<NodeId, NodeState> {
  const result = new Map<NodeId, NodeState>();
  for (const [id, node] of nodes) {
    result.set(id, {
      ...node,
      // Shallow-copy only collections needed for rendering
      log: node.log.slice(),       // needed for NodeDetail & leader badge
      nextIndex: node.nextIndex,    // read-only in rendering
      matchIndex: node.matchIndex,  // read-only in rendering
      votesReceived: node.votesReceived, // read-only (.size used)
      meta: node.meta,             // read-only in rendering
    });
  }
  return result;
}

export function useSimulation(
  algorithmType: AlgorithmType,
  nodeCount: number,
  seed: number,
  networkProfile: NetworkProfile = 'wan',
  clientCount: number = 2,
) {
  const engineRef = useRef<SimulationEngine | null>(null);
  const animFrameRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);
  const speedRef = useRef<number>(1);
  const isRunningRef = useRef<boolean>(false);
  const autoClientRef = useRef<number>(0); // next auto-client command id
  const profile = NETWORK_PROFILES[networkProfile];
  const profileRef = useRef(profile);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  const [state, setState] = useState<SimulationState>({
    time: 0,
    nodes: new Map(),
    activeMessages: [],
    metrics: EMPTY_METRICS,
    liveStats: EMPTY_LIVE_STATS,
    clients: [],
    isRunning: false,
    speed: 1,
    timeoutProgress: new Map(),
    clientConnections: [],
    autoClientTiming: new Map(),
  });
  const clusterConfig = useMemo<ClusterConfig>(() => ({
    nodeCount,
    clientCount,
    observerIds: [],
    networkConfig: {
      minDelay: profile.minDelay,
      maxDelay: profile.maxDelay,
      packetLossRate: 0,
      partitions: [],
    },
    electionTimeoutMin: profile.electionTimeoutMin,
    electionTimeoutMax: profile.electionTimeoutMax,
    heartbeatInterval: profile.heartbeatInterval,
  }), [nodeCount, clientCount, profile]);

  useEffect(() => {
    cancelAnimationFrame(animFrameRef.current);
    isRunningRef.current = false;
    autoClientRef.current = 0;

    const algorithm = createAlgorithm(algorithmType);
    const engine = new SimulationEngine(algorithm, clusterConfig, seed);
    engineRef.current = engine;

    setState({
      time: 0,
      nodes: snapshotNodes(engine.getNodes()),
      activeMessages: [],
      metrics: EMPTY_METRICS,
      liveStats: engine.getLiveStats(),
      clients: engine.getClients(),
      isRunning: false,
      speed: speedRef.current,
      timeoutProgress: new Map(),
      clientConnections: [],
      autoClientTiming: new Map(),
    });
  }, [algorithmType, nodeCount, clientCount, seed, clusterConfig]);

  const syncState = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;

    // Compute per-client next auto-fire time (skip indices before start delay)
    const autoClientTiming = new Map<string, number>();
    const curClientCount = engine.getClientCount();
    const acInterval = profileRef.current.autoClientInterval;
    const acStartDelay = profileRef.current.autoClientStartDelay;
    if (curClientCount > 0) {
      const currentIdx = autoClientRef.current;
      for (let i = 0; i < curClientCount; i++) {
        const remainder = currentIdx % curClientCount;
        let offset = i - remainder;
        if (offset < 0) offset += curClientCount;
        let nextIdx = currentIdx + offset;
        while (nextIdx * acInterval < acStartDelay) {
          nextIdx += curClientCount;
        }
        autoClientTiming.set(`client_${i}`, nextIdx * acInterval);
      }
    }

    setState(prev => ({
      ...prev,
      time: engine.getTime(),
      nodes: snapshotNodes(engine.getNodes()),
      activeMessages: [...engine.getActiveMessages()],
      metrics: { ...engine.getMetrics() },
      liveStats: engine.getLiveStats(),
      clients: engine.getClients(),
      timeoutProgress: engine.getTimeoutProgress(),
      clientConnections: engine.getClientConnections(),
      autoClientTiming,
    }));
  }, []);

  const tickRef = useRef<(timestamp: number) => void>(() => {});
  const tickFn = (timestamp: number) => {
    const engine = engineRef.current;
    if (!engine || !isRunningRef.current) return;

    if (lastTickRef.current === 0) {
      lastTickRef.current = timestamp;
    }

    const deltaMs = Math.min(timestamp - lastTickRef.current, MAX_FRAME_DELTA_MS);
    lastTickRef.current = timestamp;

    const virtualDelta = deltaMs * speedRef.current;
    const targetTime = engine.getTime() + virtualDelta;

    // Auto-generate client writes periodically in virtual time
    const pAutoInterval = profileRef.current.autoClientInterval;
    const pAutoStartDelay = profileRef.current.autoClientStartDelay;
    while (autoClientRef.current * pAutoInterval < targetTime) {
      const cmdTime = autoClientRef.current * pAutoInterval;
      if (cmdTime > engine.getTime() && cmdTime >= pAutoStartDelay) {
        const clientCount = engine.getClientCount();
        const clientId = `client_${autoClientRef.current % clientCount}`;
        const command = `cmd_${autoClientRef.current}`;
        engine.submitClientRequest(command, clientId);
      }
      autoClientRef.current++;
    }

    engine.runUntil(targetTime);
    syncState();

    if (isRunningRef.current) {
      animFrameRef.current = requestAnimationFrame((ts) => tickRef.current!(ts));
    }
  };
  useEffect(() => { tickRef.current = tickFn; });

  const play = useCallback(() => {
    isRunningRef.current = true;
    lastTickRef.current = 0;
    setState(p => ({ ...p, isRunning: true }));
    animFrameRef.current = requestAnimationFrame((ts) => tickRef.current!(ts));
  }, []);

  const pause = useCallback(() => {
    isRunningRef.current = false;
    cancelAnimationFrame(animFrameRef.current);
    setState(p => ({ ...p, isRunning: false }));
  }, []);

  const step = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.step();
    syncState();
  }, [syncState]);

  const setSpeed = useCallback((speed: number) => {
    speedRef.current = speed;
    setState(p => ({ ...p, speed }));
  }, []);

  const reset = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    isRunningRef.current = false;
    autoClientRef.current = 0;

    const algorithm = createAlgorithm(algorithmType);
    const engine = new SimulationEngine(algorithm, clusterConfig, seed);
    engineRef.current = engine;

    setState({
      time: 0,
      nodes: snapshotNodes(engine.getNodes()),
      activeMessages: [],
      metrics: EMPTY_METRICS,
      liveStats: engine.getLiveStats(),
      clients: engine.getClients(),
      isRunning: false,
      speed: speedRef.current,
      timeoutProgress: new Map(),
      clientConnections: [],
      autoClientTiming: new Map(),
    });
  }, [algorithmType, clusterConfig, seed]);

  const killNode = useCallback((nodeId: NodeId) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.injectEvent('node_failure', nodeId, engine.getTime());
    if (!isRunningRef.current) { engine.step(); syncState(); }
  }, [syncState]);

  const recoverNode = useCallback((nodeId: NodeId) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.injectEvent('node_recovery', nodeId, engine.getTime());
    if (!isRunningRef.current) { engine.step(); syncState(); }
  }, [syncState]);

  const submitRequest = useCallback((command: string, clientId?: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.submitClientRequest(command, clientId ?? 'client_0');
    if (!isRunningRef.current) { engine.step(); syncState(); }
  }, [syncState]);

  const addClient = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.addClient();
    syncState();
  }, [syncState]);

  const removeClient = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.removeClient();
    syncState();
  }, [syncState]);

  return {
    state,
    play, pause, step, reset,
    setSpeed,
    killNode, recoverNode, submitRequest,
    addClient, removeClient,
  };
}

export { DEFAULT_CLUSTER_CONFIG };
