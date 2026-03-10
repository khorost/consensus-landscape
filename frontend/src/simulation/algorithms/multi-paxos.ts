import { ConsensusAlgorithm } from './interface';
import {
  NodeState, NodeId, Message, Action, ClusterConfig, TimeoutType, LogEntry,
} from '../types';
import {
  PAXOS_PROPOSAL_BASE_TIMEOUT, PAXOS_PROPOSAL_PER_NODE_INCREMENT, PAXOS_PROPOSAL_JITTER,
  PAXOS_NACK_BACKOFF_BASE, PAXOS_NACK_BACKOFF_PER_NODE, PAXOS_NACK_BACKOFF_JITTER,
} from '../constants';

/**
 * Multi-Paxos — optimized Paxos with a stable leader.
 *
 * After a leader is elected via Prepare/Promise (phase 1), subsequent
 * proposals skip phase 1 entirely. The leader sends Accept directly.
 * Heartbeats maintain leadership, similar to Raft.
 *
 * Key differences from Basic Paxos visible in simulation:
 * - Stable leader (green node) with heartbeats
 * - Steady-state commits in 1 RTT (Accept/Accepted) instead of 2 RTT
 * - Falls back to full 2-phase when leadership is lost
 */
export class MultiPaxosAlgorithm implements ConsensusAlgorithm {
  readonly name = 'Multi-Paxos';
  readonly description = 'Paxos with stable leader — skip Prepare phase after election';

  getInitialState(nodeId: NodeId, config: ClusterConfig): NodeState {
    const allNodes = Array.from({ length: config.nodeCount }, (_, i) => `node_${i}`);
    const nodeIndex = parseInt(nodeId.split('_')[1]);

    return {
      id: nodeId,
      role: 'follower',
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
        seqNum: 0,
        proposalNumber: 0,
        leaderBallot: 0,
        promisesReceived: 0,
        acceptsReceived: 0,
        isElecting: false,
        knownLeader: null as NodeId | null,
        commandQueue: [] as string[],
        proposalPhase: null as 'prepare' | 'accept' | null,
        pendingValue: null as string | null,
        leaderEstablished: false,  // true after first successful commit — enables Phase 1 skip
        // Acceptor state
        minProposal: 0,
        acceptedProposal: -1,
        acceptedValue: null as string | null,
        heartbeatInterval: config.heartbeatInterval,
      },
    };
  }

  canAcceptClientRequest(node: NodeState): boolean {
    return node.role === 'leader' && node.status === 'alive';
  }

  getKnownLeader(node: NodeState): NodeId | null {
    if (node.role === 'leader') return node.id;
    return (node.meta.knownLeader as NodeId | null) ?? null;
  }

  onMessage(node: NodeState, msg: Message): Action[] {
    switch (msg.type) {
      case 'prepare': return this.handlePrepare(node, msg);
      case 'promise': return this.handlePromise(node, msg);
      case 'accept': return this.handleAccept(node, msg);
      case 'accepted': return this.handleAccepted(node, msg);
      case 'nack': return this.handleNack(node, msg);
      case 'learn': return this.handleLearn(node, msg);
      case 'mp_heartbeat': return this.handleHeartbeat(node, msg);
      case 'mp_heartbeat_response': return [];
      default: return [];
    }
  }

  onTimeout(node: NodeState, type: TimeoutType): Action[] {
    if (type === 'election') {
      // Election timeout — start new Prepare round to claim leadership
      return this.startElection(node);
    }
    if (type === 'heartbeat' && node.role === 'leader') {
      return this.sendHeartbeats(node);
    }
    return [];
  }

  onClientRequest(node: NodeState, command: string): Action[] {
    if (node.role !== 'leader') {
      return [{
        type: 'send_message',
        message: {
          type: 'client_response',
          from: node.id, to: node.id,
          term: node.currentTerm,
          payload: { success: false, redirect: true, leaderHint: this.getKnownLeader(node) },
        },
      }];
    }

    (node.meta.commandQueue as string[]).push(command);

    if (!node.meta.pendingValue) {
      return this.proposeNext(node);
    }
    return [];
  }

  onRecovery(node: NodeState, config: ClusterConfig): Action[] {
    node.role = 'follower';
    node.meta.isElecting = false;
    node.meta.proposalPhase = null;
    node.meta.pendingValue = null;
    node.meta.promisesReceived = 0;
    node.meta.acceptsReceived = 0;
    node.meta.knownLeader = null;
    node.meta.leaderEstablished = false;

    return [{
      type: 'set_timeout',
      timeout: { type: 'election', duration: this.randomTimeout(config), nodeId: node.id },
    }];
  }

  // ---- Leader election (Phase 1) ----

  private startElection(node: NodeState): Action[] {
    const peers = node.meta.peers as NodeId[];
    const nodeCount = peers.length + 1;
    const nodeIndex = node.meta.nodeIndex as number;

    node.meta.seqNum = (node.meta.seqNum as number) + 1;
    const proposalNumber = (node.meta.seqNum as number) * nodeCount + nodeIndex;

    node.meta.proposalNumber = proposalNumber;
    node.currentTerm = proposalNumber;
    node.role = 'candidate';
    node.meta.isElecting = true;
    node.meta.proposalPhase = 'prepare';
    node.meta.promisesReceived = 1; // self
    node.meta.knownLeader = null;
    node.votesReceived.clear();
    node.votesReceived.add(node.id);

    // Self-promise
    if (proposalNumber > (node.meta.minProposal as number)) {
      node.meta.minProposal = proposalNumber;
    }

    const actions: Action[] = [];
    for (const peer of peers) {
      actions.push({
        type: 'send_message',
        message: {
          type: 'prepare', from: node.id, to: peer, term: proposalNumber,
          payload: { proposalNumber },
        },
      });
    }

    const baseDuration = PAXOS_PROPOSAL_BASE_TIMEOUT + nodeIndex * PAXOS_PROPOSAL_PER_NODE_INCREMENT;
    actions.push({
      type: 'set_timeout',
      timeout: { type: 'election', duration: baseDuration + Math.random() * PAXOS_PROPOSAL_JITTER, nodeId: node.id },
    });

    return actions;
  }

  private handlePrepare(node: NodeState, msg: Message): Action[] {
    const { proposalNumber } = msg.payload as { proposalNumber: number };

    if (proposalNumber > (node.meta.minProposal as number)) {
      node.meta.minProposal = proposalNumber;
      // Step down if we were leader with lower ballot
      if (node.role === 'leader' && proposalNumber > (node.meta.leaderBallot as number)) {
        node.role = 'follower';
        node.meta.knownLeader = null;
      }

      return [{
        type: 'send_message',
        message: {
          type: 'promise', from: node.id, to: msg.from, term: proposalNumber,
          payload: {
            proposalNumber,
            acceptedProposal: node.meta.acceptedProposal,
            acceptedValue: node.meta.acceptedValue,
          },
        },
      }];
    }

    return [{
      type: 'send_message',
      message: {
        type: 'nack', from: node.id, to: msg.from, term: node.meta.minProposal as number,
        payload: { proposalNumber, highestSeen: node.meta.minProposal },
      },
    }];
  }

  private handlePromise(node: NodeState, msg: Message): Action[] {
    if (node.meta.proposalPhase !== 'prepare') return [];

    const { proposalNumber, acceptedProposal, acceptedValue } = msg.payload as {
      proposalNumber: number; acceptedProposal: number; acceptedValue: string | null;
    };

    // During election: check against proposalNumber; as leader: check against leaderBallot
    const expectedBallot = node.meta.isElecting
      ? node.meta.proposalNumber as number
      : node.meta.leaderBallot as number;
    if (proposalNumber !== expectedBallot) return [];

    node.votesReceived.add(msg.from);
    node.meta.promisesReceived = (node.meta.promisesReceived as number) + 1;

    // Adopt highest accepted value (skip already committed)
    if (acceptedProposal > (node.meta.acceptedProposal as number) && acceptedValue !== null) {
      const alreadyCommitted = node.log.some(e => e.command === acceptedValue && e.committed);
      if (!alreadyCommitted) {
        node.meta.acceptedProposal = acceptedProposal;
        node.meta.acceptedValue = acceptedValue;
      }
    }

    const peers = node.meta.peers as NodeId[];
    const majority = Math.floor((peers.length + 1) / 2) + 1;

    if ((node.meta.promisesReceived as number) >= majority) {
      if (node.meta.isElecting) {
        // Election complete — become leader
        return this.becomeLeader(node);
      }
      // Leader's confirmation Prepare done — now send Accept (Phase 2)
      return this.sendAcceptForPending(node);
    }
    return [];
  }

  private becomeLeader(node: NodeState): Action[] {
    node.role = 'leader';
    node.meta.isElecting = false;
    node.meta.proposalPhase = null;
    node.meta.leaderBallot = node.meta.proposalNumber;
    node.meta.leaderEstablished = false; // first proposal will use full 2-phase
    node.meta.knownLeader = node.id;

    const actions: Action[] = [
      { type: 'cancel_timeout', timeout: { type: 'election', duration: 0, nodeId: node.id } },
      { type: 'set_timeout', timeout: { type: 'heartbeat', duration: (node.meta.heartbeatInterval as number), nodeId: node.id } },
    ];

    // Send initial heartbeats
    actions.push(...this.sendHeartbeats(node));

    // If we had adopted an accepted value, propose it now
    const adoptedValue = node.meta.acceptedValue as string | null;
    if (adoptedValue !== null) {
      const alreadyCommitted = node.log.some(e => e.command === adoptedValue && e.committed);
      if (!alreadyCommitted) {
        (node.meta.commandQueue as string[]).unshift(adoptedValue);
      }
      node.meta.acceptedProposal = -1;
      node.meta.acceptedValue = null;
    }

    // Start proposing if we have queued commands
    if ((node.meta.commandQueue as string[]).length > 0) {
      actions.push(...this.proposeNext(node));
    }

    return actions;
  }

  // ---- Steady-state: skip Phase 1, go directly to Accept ----

  private proposeNext(node: NodeState): Action[] {
    const queue = node.meta.commandQueue as string[];
    if (queue.length === 0 || node.role !== 'leader') {
      node.meta.pendingValue = null;
      return [];
    }

    const value = queue[0];
    node.meta.pendingValue = value;

    const ballot = node.meta.leaderBallot as number;
    const peers = node.meta.peers as NodeId[];
    const actions: Action[] = [];

    if (!node.meta.leaderEstablished) {
      // Full 2-phase Paxos: Prepare first, then Accept after majority Promise
      // This happens on the FIRST proposal after (re-)election
      node.meta.proposalPhase = 'prepare';
      node.meta.promisesReceived = 1; // self-promise

      for (const peer of peers) {
        actions.push({
          type: 'send_message',
          message: {
            type: 'prepare', from: node.id, to: peer, term: ballot,
            payload: { proposalNumber: ballot },
          },
        });
      }
      return actions;
    }

    // Optimized path: skip Phase 1, send Accept directly (leader already established)
    node.meta.proposalPhase = 'accept';
    node.meta.acceptsReceived = 1; // self-accept
    node.meta.acceptedProposal = ballot;
    node.meta.acceptedValue = value;

    for (const peer of peers) {
      actions.push({
        type: 'send_message',
        message: {
          type: 'accept', from: node.id, to: peer, term: ballot,
          payload: { proposalNumber: ballot, value },
        },
      });
    }
    return actions;
  }

  /** Phase 2 after leader's confirmation Prepare got majority — send Accept with pending value */
  private sendAcceptForPending(node: NodeState): Action[] {
    const value = node.meta.pendingValue as string | null;
    if (!value || node.role !== 'leader') return [];

    node.meta.proposalPhase = 'accept';
    node.meta.acceptsReceived = 1; // self-accept

    const ballot = node.meta.leaderBallot as number;
    node.meta.acceptedProposal = ballot;
    node.meta.acceptedValue = value;

    const peers = node.meta.peers as NodeId[];
    const actions: Action[] = [];
    for (const peer of peers) {
      actions.push({
        type: 'send_message',
        message: {
          type: 'accept', from: node.id, to: peer, term: ballot,
          payload: { proposalNumber: ballot, value },
        },
      });
    }
    return actions;
  }

  private handleAccept(node: NodeState, msg: Message): Action[] {
    const { proposalNumber, value } = msg.payload as { proposalNumber: number; value: string };

    if (proposalNumber >= (node.meta.minProposal as number)) {
      node.meta.minProposal = proposalNumber;
      node.meta.acceptedProposal = proposalNumber;
      node.meta.acceptedValue = value;

      // Recognize sender as leader
      if (node.role !== 'leader') {
        node.role = 'follower';
        node.meta.knownLeader = msg.from;
      }

      return [{
        type: 'send_message',
        message: {
          type: 'accepted', from: node.id, to: msg.from, term: proposalNumber,
          payload: { proposalNumber, value },
        },
      }];
    }

    return [{
      type: 'send_message',
      message: {
        type: 'nack', from: node.id, to: msg.from, term: node.meta.minProposal as number,
        payload: { proposalNumber, highestSeen: node.meta.minProposal },
      },
    }];
  }

  private handleAccepted(node: NodeState, msg: Message): Action[] {
    if (node.role !== 'leader') return [];

    const { proposalNumber, value } = msg.payload as { proposalNumber: number; value: string };
    if (proposalNumber !== node.meta.leaderBallot) return [];

    node.meta.acceptsReceived = (node.meta.acceptsReceived as number) + 1;

    const peers = node.meta.peers as NodeId[];
    const majority = Math.floor((peers.length + 1) / 2) + 1;

    if ((node.meta.acceptsReceived as number) >= majority) {
      node.meta.acceptsReceived = 0;

      const alreadyCommitted = node.log.some(e => e.command === value && e.committed);
      const queue = node.meta.commandQueue as string[];
      const idx = queue.indexOf(value);
      if (idx !== -1) queue.splice(idx, 1);

      node.meta.pendingValue = null;
      node.meta.proposalPhase = null;
      node.meta.acceptedProposal = -1;
      node.meta.acceptedValue = null;
      node.meta.leaderEstablished = true; // subsequent proposals skip Phase 1

      const actions: Action[] = [];

      if (!alreadyCommitted) {
        const entry: LogEntry = {
          term: proposalNumber, index: node.log.length,
          command: value, committed: true,
        };
        node.log.push(entry);
        node.commitIndex = node.log.length - 1;
        actions.push({ type: 'commit_entry' });

        for (const peer of peers) {
          actions.push({
            type: 'send_message',
            message: {
              type: 'learn', from: node.id, to: peer, term: proposalNumber,
              payload: { value, proposalNumber, commitIndex: node.commitIndex },
            },
          });
        }
      }

      // Propose next command
      if (queue.length > 0) {
        actions.push(...this.proposeNext(node));
      }

      return actions;
    }
    return [];
  }

  private handleNack(node: NodeState, msg: Message): Action[] {
    const { proposalNumber, highestSeen } = msg.payload as { proposalNumber: number; highestSeen: number };

    // If we're leader and our ballot got rejected, step down
    if (node.role === 'leader' && proposalNumber === node.meta.leaderBallot) {
      node.role = 'follower';
      node.meta.knownLeader = null;
      node.meta.pendingValue = null;
      node.meta.proposalPhase = null;

      const nodeCount = (node.meta.peers as NodeId[]).length + 1;
      const nodeIndex = node.meta.nodeIndex as number;
      const minSeq = Math.ceil(((highestSeen as number) - nodeIndex) / nodeCount) + 1;
      if (minSeq > (node.meta.seqNum as number)) node.meta.seqNum = minSeq;

      const backoff = PAXOS_NACK_BACKOFF_BASE + nodeIndex * PAXOS_NACK_BACKOFF_PER_NODE + Math.random() * PAXOS_NACK_BACKOFF_JITTER;
      return [
        { type: 'cancel_timeout', timeout: { type: 'heartbeat', duration: 0, nodeId: node.id } },
        { type: 'set_timeout', timeout: { type: 'election', duration: backoff, nodeId: node.id } },
      ];
    }

    // If we're electing and got nacked
    if (node.meta.isElecting && proposalNumber === node.meta.proposalNumber) {
      node.meta.isElecting = false;
      node.meta.proposalPhase = null;
      node.role = 'follower';

      const nodeCount = (node.meta.peers as NodeId[]).length + 1;
      const nodeIndex = node.meta.nodeIndex as number;
      const minSeq = Math.ceil(((highestSeen as number) - nodeIndex) / nodeCount) + 1;
      if (minSeq > (node.meta.seqNum as number)) node.meta.seqNum = minSeq;

      const backoff = PAXOS_NACK_BACKOFF_BASE + nodeIndex * PAXOS_NACK_BACKOFF_PER_NODE + Math.random() * PAXOS_NACK_BACKOFF_JITTER;
      return [{ type: 'set_timeout', timeout: { type: 'election', duration: backoff, nodeId: node.id } }];
    }

    return [];
  }

  private handleLearn(node: NodeState, msg: Message): Action[] {
    const { value, proposalNumber } = msg.payload as { value: string; proposalNumber: number };

    const alreadyCommitted = node.log.some(e => e.command === value && e.committed);
    if (!alreadyCommitted) {
      const entry: LogEntry = {
        term: proposalNumber, index: node.log.length,
        command: value, committed: true,
      };
      node.log.push(entry);
      node.commitIndex = node.log.length - 1;
    }

    node.meta.acceptedProposal = -1;
    node.meta.acceptedValue = null;

    // Remove from queue
    const queue = node.meta.commandQueue as string[];
    const idx = queue.indexOf(value);
    if (idx !== -1) queue.splice(idx, 1);

    return [];
  }

  // ---- Heartbeats ----

  private sendHeartbeats(node: NodeState): Action[] {
    const peers = node.meta.peers as NodeId[];
    const actions: Action[] = [];
    for (const peer of peers) {
      actions.push({
        type: 'send_message',
        message: {
          type: 'mp_heartbeat', from: node.id, to: peer,
          term: node.meta.leaderBallot as number,
          payload: { leaderBallot: node.meta.leaderBallot, commitIndex: node.commitIndex },
        },
      });
    }
    actions.push({
      type: 'set_timeout',
      timeout: { type: 'heartbeat', duration: (node.meta.heartbeatInterval as number), nodeId: node.id },
    });
    return actions;
  }

  private handleHeartbeat(node: NodeState, msg: Message): Action[] {
    const { leaderBallot } = msg.payload as { leaderBallot: number };

    if (leaderBallot >= (node.meta.minProposal as number)) {
      node.meta.minProposal = leaderBallot;
      node.meta.knownLeader = msg.from;
      if (node.role !== 'leader') {
        node.role = 'follower';
        node.meta.isElecting = false;
        node.meta.proposalPhase = null;
      }

      return [
        { type: 'set_timeout', timeout: { type: 'election', duration: 300 + Math.random() * 300, nodeId: node.id } },
        {
          type: 'send_message',
          message: {
            type: 'mp_heartbeat_response', from: node.id, to: msg.from,
            term: leaderBallot, payload: {},
          },
        },
      ];
    }
    return [];
  }

  private randomTimeout(config: ClusterConfig): number {
    return config.electionTimeoutMin + Math.random() * (config.electionTimeoutMax - config.electionTimeoutMin);
  }
}
