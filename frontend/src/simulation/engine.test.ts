import { describe, it, expect } from 'vitest';
import { SimulationEngine } from './engine';
import { RaftAlgorithm } from './algorithms/raft';
import { PaxosAlgorithm } from './algorithms/paxos';
import { ClusterConfig } from './types';

function makeConfig(overrides: Partial<ClusterConfig> = {}): ClusterConfig {
  return {
    nodeCount: 3,
    observerIds: [],
    networkConfig: {
      minDelay: 5,
      maxDelay: 10,
      packetLossRate: 0,
      partitions: [],
    },
    electionTimeoutMin: 50,
    electionTimeoutMax: 100,
    heartbeatInterval: 20,
    clientCount: 1,
    ...overrides,
  };
}

describe('SimulationEngine', () => {
  describe('initialization', () => {
    it('creates correct number of nodes', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig({ nodeCount: 5 }), 42);
      expect(engine.getNodes().size).toBe(5);
    });

    it('all nodes start alive', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      for (const [, node] of engine.getNodes()) {
        expect(node.status).toBe('alive');
      }
    });

    it('time starts at 0', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      expect(engine.getTime()).toBe(0);
    });

    it('creates requested number of clients', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig({ clientCount: 3 }), 42);
      expect(engine.getClients().length).toBe(3);
    });
  });

  describe('step', () => {
    it('returns null when no events', () => {
      // Paxos has no initial events scheduled
      const engine = new SimulationEngine(new PaxosAlgorithm(), makeConfig(), 42);
      expect(engine.step()).toBe(null);
    });

    it('processes events in time order', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      const e1 = engine.step();
      const e2 = engine.step();
      if (e1 && e2) {
        expect(e1.time).toBeLessThanOrEqual(e2.time);
      }
    });

    it('advances time to event time', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      engine.step();
      expect(engine.getTime()).toBeGreaterThan(0);
    });
  });

  describe('runUntil', () => {
    it('processes all events up to target time', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      const events = engine.runUntil(200);
      expect(events.length).toBeGreaterThan(0);
      expect(engine.getTime()).toBe(200);
    });

    it('does not process events beyond target time', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      const events = engine.runUntil(10);
      for (const e of events) {
        expect(e.time).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('Raft leader election', () => {
    it('elects a leader after election timeout', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      // Run long enough for election to complete
      engine.runUntil(500);
      const nodes = engine.getNodes();
      const leaders = Array.from(nodes.values()).filter(n => n.role === 'leader');
      expect(leaders.length).toBe(1);
    });

    it('leader has term >= 1', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      engine.runUntil(500);
      const nodes = engine.getNodes();
      const leader = Array.from(nodes.values()).find(n => n.role === 'leader');
      expect(leader).toBeDefined();
      expect(leader!.currentTerm).toBeGreaterThanOrEqual(1);
    });

    it('live stats track leader changes', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      engine.runUntil(500);
      const stats = engine.getLiveStats();
      expect(stats.leaderChanges).toBeGreaterThanOrEqual(1);
      expect(stats.currentLeader).not.toBeNull();
    });
  });

  describe('Raft log replication', () => {
    it('commits a client request', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      // Wait for leader election
      engine.runUntil(500);
      engine.submitClientRequest('cmd_1');
      // Run enough for replication
      engine.runUntil(1000);
      const stats = engine.getLiveStats();
      expect(stats.totalCommits).toBeGreaterThanOrEqual(1);
    });

    it('replicates log entries to followers', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      engine.runUntil(500);
      engine.submitClientRequest('cmd_1');
      engine.runUntil(1000);

      const nodes = engine.getNodes();
      // At least majority should have the entry
      let nodesWithEntry = 0;
      for (const [, node] of nodes) {
        if (node.log.some(e => e.command === 'cmd_1')) nodesWithEntry++;
      }
      expect(nodesWithEntry).toBeGreaterThanOrEqual(2); // majority of 3
    });
  });

  describe('node failure and recovery', () => {
    it('kills a node', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      engine.injectEvent('node_failure', 'node_0', 0);
      engine.step();
      const node = engine.getNodes().get('node_0')!;
      expect(node.status).toBe('dead');
    });

    it('recovers a node', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      engine.injectEvent('node_failure', 'node_0', 0);
      engine.step();
      engine.injectEvent('node_recovery', 'node_0', 1);
      engine.runUntil(2);
      const node = engine.getNodes().get('node_0')!;
      expect(node.status).toBe('alive');
    });

    it('dead nodes ignore messages', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      engine.injectEvent('node_failure', 'node_0', 0);
      engine.step();
      // Try to send a message to dead node
      engine.injectEvent('message_arrive', 'node_0', 1, {
        message: {
          id: 'test', type: 'request_vote', from: 'node_1', to: 'node_0',
          term: 1, payload: { candidateId: 'node_1', lastLogIndex: -1, lastLogTerm: 0 },
        },
      });
      engine.runUntil(2);
      // Node should still be dead, no crash
      expect(engine.getNodes().get('node_0')!.status).toBe('dead');
    });

    it('re-elects leader after leader failure', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig({ nodeCount: 5 }), 42);
      engine.runUntil(500);
      const leader = Array.from(engine.getNodes().values()).find(n => n.role === 'leader');
      expect(leader).toBeDefined();
      // Kill the leader
      engine.injectEvent('node_failure', leader!.id, 501);
      engine.runUntil(1500);
      const nodes = engine.getNodes();
      const newLeaders = Array.from(nodes.values()).filter(
        n => n.role === 'leader' && n.status === 'alive'
      );
      expect(newLeaders.length).toBe(1);
      expect(newLeaders[0].id).not.toBe(leader!.id);
    });
  });

  describe('client management', () => {
    it('addClient increases client count', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig({ clientCount: 1 }), 42);
      expect(engine.getClientCount()).toBe(1);
      engine.addClient();
      expect(engine.getClientCount()).toBe(2);
    });

    it('removeClient decreases client count', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig({ clientCount: 3 }), 42);
      engine.removeClient();
      expect(engine.getClientCount()).toBe(2);
    });

    it('removeClient does not go below 1', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig({ clientCount: 1 }), 42);
      const result = engine.removeClient();
      expect(result).toBeNull();
      expect(engine.getClientCount()).toBe(1);
    });
  });

  describe('cluster status', () => {
    it('has quorum with all nodes alive', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig({ nodeCount: 3 }), 42);
      const { hasQuorum } = engine.getClusterStatus();
      expect(hasQuorum).toBe(true);
    });

    it('loses quorum when majority dies', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig({ nodeCount: 3 }), 42);
      engine.injectEvent('node_failure', 'node_0', 0);
      engine.injectEvent('node_failure', 'node_1', 0);
      engine.runUntil(1);
      const { hasQuorum } = engine.getClusterStatus();
      expect(hasQuorum).toBe(false);
    });
  });

  describe('metrics', () => {
    it('records commit latencies', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      engine.runUntil(500);
      engine.submitClientRequest('test_cmd');
      engine.runUntil(1000);
      const metrics = engine.getMetrics();
      if (engine.getLiveStats().totalCommits > 0) {
        expect(metrics.commitLatencies.length).toBeGreaterThan(0);
        expect(metrics.commitTimestamps.length).toBe(metrics.commitLatencies.length);
      }
    });

    it('tracks leader change timestamps', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      engine.runUntil(500);
      const metrics = engine.getMetrics();
      expect(metrics.leaderChangeTimestamps.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('timeout progress', () => {
    it('returns progress for active timeouts', () => {
      const engine = new SimulationEngine(new RaftAlgorithm(), makeConfig(), 42);
      // At time 0, all nodes have election timeouts
      const progress = engine.getTimeoutProgress();
      expect(progress.size).toBeGreaterThan(0);
    });
  });
});
