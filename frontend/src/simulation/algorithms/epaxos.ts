import { ConsensusAlgorithm } from './interface';
import {
  NodeState, NodeId, Message, Action, ClusterConfig, TimeoutType, LogEntry,
} from '../types';

/**
 * EPaxos (Egalitarian Paxos) — leaderless consensus with optimal latency.
 *
 * Any node ("replica") can propose. Fast path (1 RTT) when no conflicts.
 * Slow path (2 RTT) when conflicts require explicit dependency resolution.
 *
 * Key differences from other algorithms visible in simulation:
 * - No leader — all nodes are equal blue "R" replicas
 * - Most commits in 1 RTT (fast path) vs 2 RTT (Paxos) or leader bottleneck (Raft)
 * - Conflicts trigger visible slow-path messages (purple diamonds)
 * - Dependency tracking between concurrent commands
 *
 * Simplified for educational clarity:
 * - "Conflict" = two uncommitted commands from different replicas
 * - No explicit execution ordering (Tarjan's SCC omitted)
 */

interface Instance {
  command: string;
  status: 'pre-accepted' | 'accepted' | 'committed';
  seq: number;
  deps: string[];         // dependency instance IDs
  ballot: number;
  leaderNode: NodeId;
  preAcceptOks: number;
  acceptOks: number;
  allDepsMatch: boolean;
}

export class EPaxosAlgorithm implements ConsensusAlgorithm {
  readonly name = 'EPaxos';
  readonly description = 'Egalitarian Paxos — leaderless, optimal commit latency';

  getInitialState(nodeId: NodeId, config: ClusterConfig): NodeState {
    const allNodes = Array.from({ length: config.nodeCount }, (_, i) => `node_${i}`);
    const nodeIndex = parseInt(nodeId.split('_')[1]);

    return {
      id: nodeId,
      role: 'replica',
      status: 'alive',
      currentTerm: 0,
      votedFor: null,
      log: [],
      commitIndex: -1,
      lastApplied: -1,
      nextIndex: new Map(),
      matchIndex: new Map(),
      votesReceived: new Set(),
      meta: {
        peers: allNodes.filter(id => id !== nodeId),
        nodeIndex,
        instanceCounter: 0,
        instances: {} as Record<string, Instance>,
        commandQueue: [] as string[],
        maxSeq: 0,
        activeInstance: null as string | null,  // currently proposing instance key
      },
    };
  }

  canAcceptClientRequest(node: NodeState): boolean {
    return node.role === 'replica' && node.status === 'alive';
  }

  getKnownLeader(_node: NodeState): NodeId | null { // eslint-disable-line @typescript-eslint/no-unused-vars
    return null; // no leader
  }

  onMessage(node: NodeState, msg: Message): Action[] {
    switch (msg.type) {
      case 'ep_preaccept': return this.handlePreAccept(node, msg);
      case 'ep_preaccept_ok': return this.handlePreAcceptOk(node, msg);
      case 'ep_accept': return this.handleAccept(node, msg);
      case 'ep_accept_ok': return this.handleAcceptOk(node, msg);
      case 'ep_commit': return this.handleCommit(node, msg);
      default: return [];
    }
  }

  onTimeout(node: NodeState, type: TimeoutType): Action[] {
    if (type === 'proposal') {
      // Proposal timeout — retry via slow path or re-propose
      const activeKey = node.meta.activeInstance as string | null;
      if (activeKey) {
        const instances = node.meta.instances as Record<string, Instance>;
        const inst = instances[activeKey];
        if (inst && inst.status === 'pre-accepted') {
          // Didn't get fast quorum — go to slow path
          return this.startSlowPath(node, activeKey, inst);
        }
      }
      // Try next command if queue non-empty
      if ((node.meta.commandQueue as string[]).length > 0) {
        return this.proposeNext(node);
      }
    }
    return [];
  }

  onClientRequest(node: NodeState, command: string): Action[] {
    (node.meta.commandQueue as string[]).push(command);

    if (!node.meta.activeInstance) {
      return this.proposeNext(node);
    }
    return [];
  }

  onRecovery(node: NodeState, _config: ClusterConfig): Action[] { // eslint-disable-line @typescript-eslint/no-unused-vars
    node.role = 'replica';
    node.meta.activeInstance = null;
    return [];
  }

  // ---- Fast path: PreAccept ----

  private proposeNext(node: NodeState): Action[] {
    const queue = node.meta.commandQueue as string[];
    if (queue.length === 0) {
      node.meta.activeInstance = null;
      return [];
    }

    const command = queue.shift()!;
    node.meta.instanceCounter = (node.meta.instanceCounter as number) + 1;
    const instanceKey = `${node.id}:${node.meta.instanceCounter}`;

    const seq = (node.meta.maxSeq as number) + 1;
    node.meta.maxSeq = seq;

    // Find dependencies: other replicas' uncommitted instances
    const deps = this.findDependencies(node, instanceKey);

    const instances = node.meta.instances as Record<string, Instance>;
    instances[instanceKey] = {
      command,
      status: 'pre-accepted',
      seq,
      deps,
      ballot: 0,
      leaderNode: node.id,
      preAcceptOks: 1, // self
      acceptOks: 0,
      allDepsMatch: true,
    };

    node.meta.activeInstance = instanceKey;

    const peers = node.meta.peers as NodeId[];
    const actions: Action[] = [];

    // Send PreAccept to fast quorum (all peers for simplicity)
    for (const peer of peers) {
      actions.push({
        type: 'send_message',
        message: {
          type: 'ep_preaccept', from: node.id, to: peer,
          term: 0,
          payload: { instanceKey, command, seq, deps },
        },
      });
    }

    // Timeout for slow path fallback
    actions.push({
      type: 'set_timeout',
      timeout: { type: 'proposal', duration: 300 + Math.random() * 200, nodeId: node.id },
    });

    return actions;
  }

  private handlePreAccept(node: NodeState, msg: Message): Action[] {
    const { instanceKey, command, seq, deps } = msg.payload as {
      instanceKey: string; command: string; seq: number; deps: string[];
    };

    // Update maxSeq
    if (seq > (node.meta.maxSeq as number)) {
      node.meta.maxSeq = seq;
    }

    // Check for conflicts: find our own dependencies for this command
    const myDeps = this.findDependencies(node, instanceKey);
    let mySeq = seq;

    // If we have a higher seq requirement, bump it
    const maxLocalSeq = node.meta.maxSeq as number;
    if (maxLocalSeq >= seq) {
      mySeq = maxLocalSeq + 1;
      node.meta.maxSeq = mySeq;
    }

    // Store the instance
    const instances = node.meta.instances as Record<string, Instance>;
    instances[instanceKey] = {
      command,
      status: 'pre-accepted',
      seq: mySeq,
      deps: myDeps,
      ballot: 0,
      leaderNode: msg.from,
      preAcceptOks: 0,
      acceptOks: 0,
      allDepsMatch: true,
    };

    // Check if deps match what the leader proposed
    const depsMatch = mySeq === seq && this.depsEqual(myDeps, deps);

    return [{
      type: 'send_message',
      message: {
        type: 'ep_preaccept_ok', from: node.id, to: msg.from,
        term: 0,
        payload: { instanceKey, seq: mySeq, deps: myDeps, depsMatch },
      },
    }];
  }

  private handlePreAcceptOk(node: NodeState, msg: Message): Action[] {
    const { instanceKey, seq, deps, depsMatch } = msg.payload as {
      instanceKey: string; seq: number; deps: string[]; depsMatch: boolean;
    };

    const instances = node.meta.instances as Record<string, Instance>;
    const inst = instances[instanceKey];
    if (!inst || inst.status !== 'pre-accepted') return [];

    inst.preAcceptOks++;
    if (!depsMatch) {
      inst.allDepsMatch = false;
      // Merge deps and take max seq
      if (seq > inst.seq) inst.seq = seq;
      for (const d of deps) {
        if (!inst.deps.includes(d)) inst.deps.push(d);
      }
    }

    if (seq > (node.meta.maxSeq as number)) {
      node.meta.maxSeq = seq;
    }

    const peers = node.meta.peers as NodeId[];
    const fastQuorum = Math.floor((peers.length + 1) / 2) + 1; // floor(N/2) + 1

    if (inst.preAcceptOks >= fastQuorum) {
      if (inst.allDepsMatch) {
        // Fast path — commit directly!
        return this.commitInstance(node, instanceKey, inst);
      } else {
        // Slow path needed — start explicit Accept phase
        return this.startSlowPath(node, instanceKey, inst);
      }
    }
    return [];
  }

  // ---- Slow path: Accept ----

  private startSlowPath(node: NodeState, instanceKey: string, inst: Instance): Action[] {
    inst.status = 'accepted';
    inst.acceptOks = 1; // self

    const peers = node.meta.peers as NodeId[];
    const actions: Action[] = [];

    for (const peer of peers) {
      actions.push({
        type: 'send_message',
        message: {
          type: 'ep_accept', from: node.id, to: peer,
          term: 0,
          payload: { instanceKey, command: inst.command, seq: inst.seq, deps: inst.deps },
        },
      });
    }

    // New timeout for accept phase
    actions.push({
      type: 'set_timeout',
      timeout: { type: 'proposal', duration: 400 + Math.random() * 200, nodeId: node.id },
    });

    return actions;
  }

  private handleAccept(node: NodeState, msg: Message): Action[] {
    const { instanceKey, command, seq, deps } = msg.payload as {
      instanceKey: string; command: string; seq: number; deps: string[];
    };

    const instances = node.meta.instances as Record<string, Instance>;
    instances[instanceKey] = {
      command, status: 'accepted', seq, deps,
      ballot: 0, leaderNode: msg.from,
      preAcceptOks: 0, acceptOks: 0, allDepsMatch: true,
    };

    if (seq > (node.meta.maxSeq as number)) {
      node.meta.maxSeq = seq;
    }

    return [{
      type: 'send_message',
      message: {
        type: 'ep_accept_ok', from: node.id, to: msg.from,
        term: 0,
        payload: { instanceKey },
      },
    }];
  }

  private handleAcceptOk(node: NodeState, msg: Message): Action[] {
    const { instanceKey } = msg.payload as { instanceKey: string };

    const instances = node.meta.instances as Record<string, Instance>;
    const inst = instances[instanceKey];
    if (!inst || inst.status !== 'accepted') return [];

    inst.acceptOks++;

    const peers = node.meta.peers as NodeId[];
    const majority = Math.floor((peers.length + 1) / 2) + 1;

    if (inst.acceptOks >= majority) {
      return this.commitInstance(node, instanceKey, inst);
    }
    return [];
  }

  // ---- Commit ----

  private commitInstance(node: NodeState, instanceKey: string, inst: Instance): Action[] {
    inst.status = 'committed';
    node.meta.activeInstance = null;

    // Add to log
    const alreadyCommitted = node.log.some(e => e.command === inst.command && e.committed);
    const actions: Action[] = [];

    if (!alreadyCommitted) {
      const entry: LogEntry = {
        term: inst.seq, index: node.log.length,
        command: inst.command, committed: true,
      };
      node.log.push(entry);
      node.commitIndex = node.log.length - 1;
      node.currentTerm = Math.max(node.currentTerm, inst.seq);
      actions.push({ type: 'commit_entry' });
    }

    // Broadcast commit to all
    const peers = node.meta.peers as NodeId[];
    for (const peer of peers) {
      actions.push({
        type: 'send_message',
        message: {
          type: 'ep_commit', from: node.id, to: peer,
          term: inst.seq,
          payload: {
            instanceKey, command: inst.command,
            seq: inst.seq, deps: inst.deps,
          },
        },
      });
    }

    actions.push({
      type: 'cancel_timeout',
      timeout: { type: 'proposal', duration: 0, nodeId: node.id },
    });

    // Propose next command if queued
    if ((node.meta.commandQueue as string[]).length > 0) {
      actions.push(...this.proposeNext(node));
    }

    return actions;
  }

  private handleCommit(node: NodeState, msg: Message): Action[] {
    const { instanceKey, command, seq, deps } = msg.payload as {
      instanceKey: string; command: string; seq: number; deps: string[];
    };

    const instances = node.meta.instances as Record<string, Instance>;
    instances[instanceKey] = {
      command, status: 'committed', seq, deps,
      ballot: 0, leaderNode: msg.from,
      preAcceptOks: 0, acceptOks: 0, allDepsMatch: true,
    };

    if (seq > (node.meta.maxSeq as number)) {
      node.meta.maxSeq = seq;
    }

    const alreadyCommitted = node.log.some(e => e.command === command && e.committed);
    if (!alreadyCommitted) {
      const entry: LogEntry = {
        term: seq, index: node.log.length,
        command, committed: true,
      };
      node.log.push(entry);
      node.commitIndex = node.log.length - 1;
      node.currentTerm = Math.max(node.currentTerm, seq);
    }

    // Remove from queue
    const queue = node.meta.commandQueue as string[];
    const idx = queue.indexOf(command);
    if (idx !== -1) queue.splice(idx, 1);

    return [];
  }

  // ---- Helpers ----

  private findDependencies(node: NodeState, excludeKey: string): string[] {
    const instances = node.meta.instances as Record<string, Instance>;
    const deps: string[] = [];
    for (const [key, inst] of Object.entries(instances)) {
      if (key === excludeKey) continue;
      // Simplified conflict: any uncommitted instance from a different replica
      if (inst.status !== 'committed' && inst.leaderNode !== node.id) {
        deps.push(key);
      }
    }
    return deps;
  }

  private depsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const setA = new Set(a);
    return b.every(d => setA.has(d));
  }
}
