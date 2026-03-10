import { ConsensusAlgorithm } from './interface';
import {
  NodeState, NodeId, Message, Action, ClusterConfig, TimeoutType, LogEntry,
} from '../types';
import {
  PAXOS_PROPOSAL_BASE_TIMEOUT, PAXOS_PROPOSAL_PER_NODE_INCREMENT, PAXOS_PROPOSAL_JITTER,
  PAXOS_NACK_BACKOFF_BASE, PAXOS_NACK_BACKOFF_PER_NODE, PAXOS_NACK_BACKOFF_JITTER,
} from '../constants';

/**
 * Classic (Basic) Paxos — no stable leader, no heartbeats.
 *
 * Key differences from Raft visible in simulation:
 * - ANY node can propose (become proposer) at any time
 * - No heartbeats — nodes propose when they receive client requests
 * - Each value requires full Prepare→Promise→Accept→Accepted cycle
 * - Competing proposers cause NACKs and retries (dueling proposers)
 * - Proposal numbers are globally unique: nodeIndex * 1000 + seqNum
 *   so different nodes never collide on proposal numbers
 */
export class PaxosAlgorithm implements ConsensusAlgorithm {
  readonly name = 'Paxos';
  readonly description = 'Classic quorum-based consensus — any node can propose, no stable leader';

  getInitialState(nodeId: NodeId, config: ClusterConfig): NodeState {
    const allNodes = Array.from({ length: config.nodeCount }, (_, i) => `node_${i}`);
    const nodeIndex = parseInt(nodeId.split('_')[1]);

    return {
      id: nodeId,
      role: 'acceptor', // everyone starts as acceptor
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
        // Proposer state (active when proposing)
        seqNum: 0,                       // local sequence counter
        proposalNumber: 0,               // current proposal number = nodeIndex + seqNum*nodeCount
        promisesReceived: 0,
        acceptsReceived: 0,
        highestPromisedProposal: 0,      // from acceptor responses
        highestPromisedValue: null as string | null,
        pendingValue: null as string | null,
        isProposing: false,              // actively running a proposal round
        proposalPhase: null as 'prepare' | 'accept' | null, // current phase for display
        // Acceptor state (always active)
        minProposal: 0,                  // highest proposal number promised
        acceptedProposal: -1,            // highest proposal number accepted
        acceptedValue: null as string | null,
        // Queue of commands waiting to be proposed
        commandQueue: [] as string[],
      },
    };
  }

  canAcceptClientRequest(node: NodeState): boolean {
    // In Paxos, any alive node can accept client requests
    return node.status === 'alive';
  }

  getKnownLeader(_node: NodeState): NodeId | null { // eslint-disable-line @typescript-eslint/no-unused-vars
    // Paxos has no leader concept — return null
    return null;
  }

  onMessage(node: NodeState, msg: Message): Action[] {
    switch (msg.type) {
      case 'prepare': return this.handlePrepare(node, msg);
      case 'promise': return this.handlePromise(node, msg);
      case 'accept': return this.handleAccept(node, msg);
      case 'accepted': return this.handleAccepted(node, msg);
      case 'nack': return this.handleNack(node, msg);
      case 'learn': return this.handleLearn(node, msg);
      default: return [];
    }
  }

  onTimeout(node: NodeState, type: TimeoutType): Action[] {
    if (type === 'election') {
      // Proposal timeout — retry if still have pending value
      if (node.meta.isProposing || (node.meta.commandQueue as string[]).length > 0) {
        return this.startProposal(node);
      }
    }
    // No heartbeat in classic Paxos
    return [];
  }

  onClientRequest(node: NodeState, command: string): Action[] {
    // Any node can accept client requests in Paxos
    (node.meta.commandQueue as string[]).push(command);

    // If not already proposing, start a proposal
    if (!node.meta.isProposing) {
      return this.startProposal(node);
    }

    return [];
  }

  onRecovery(node: NodeState, config: ClusterConfig): Action[] {
    node.role = 'acceptor';
    node.meta.isProposing = false;
    node.meta.proposalPhase = null;
    node.meta.promisesReceived = 0;
    node.meta.acceptsReceived = 0;

    return [{
      type: 'set_timeout',
      timeout: { type: 'election', duration: this.randomTimeout(config), nodeId: node.id },
    }];
  }

  // ---- Proposer: Phase 1 — Prepare ----

  private startProposal(node: NodeState): Action[] {
    const queue = node.meta.commandQueue as string[];
    if (queue.length === 0) {
      node.meta.isProposing = false;
      node.role = 'acceptor';
      return [];
    }

    const peers = node.meta.peers as NodeId[];
    const nodeCount = peers.length + 1;
    const nodeIndex = node.meta.nodeIndex as number;

    // Generate unique proposal number: ensures no two nodes pick the same number
    node.meta.seqNum = (node.meta.seqNum as number) + 1;
    const proposalNumber = (node.meta.seqNum as number) * nodeCount + nodeIndex;

    node.meta.proposalNumber = proposalNumber;
    node.currentTerm = proposalNumber;
    node.role = 'proposer';
    node.meta.isProposing = true;
    node.meta.proposalPhase = 'prepare';
    node.meta.promisesReceived = 1; // count self
    node.meta.acceptsReceived = 0;
    node.meta.pendingValue = queue[0]; // propose first command in queue
    node.votesReceived.clear();
    node.votesReceived.add(node.id);

    // Self-promise (acceptor part): adopt own accepted value if any
    // Skip values already committed (stale state from previous slot)
    const selfAcceptedProposal = node.meta.acceptedProposal as number;
    const selfAcceptedValue = node.meta.acceptedValue as string | null;
    const selfAlreadyCommitted = selfAcceptedValue !== null &&
      node.log.some(e => e.command === selfAcceptedValue && e.committed);
    if (selfAcceptedProposal > 0 && selfAcceptedValue !== null && !selfAlreadyCommitted) {
      node.meta.highestPromisedProposal = selfAcceptedProposal;
      node.meta.highestPromisedValue = selfAcceptedValue;
    } else {
      node.meta.highestPromisedProposal = 0;
      node.meta.highestPromisedValue = null;
    }

    if (proposalNumber > (node.meta.minProposal as number)) {
      node.meta.minProposal = proposalNumber;
    }

    const actions: Action[] = [];

    for (const peer of peers) {
      actions.push({
        type: 'send_message',
        message: {
          type: 'prepare',
          from: node.id,
          to: peer,
          term: proposalNumber,
          payload: { proposalNumber },
        },
      });
    }

    // Timeout: if we don't get quorum, retry with higher number
    // Non-uniform per node to break dueling proposers: lower-index nodes wait less
    const baseDuration = PAXOS_PROPOSAL_BASE_TIMEOUT + nodeIndex * PAXOS_PROPOSAL_PER_NODE_INCREMENT;
    actions.push({
      type: 'set_timeout',
      timeout: {
        type: 'election',
        duration: baseDuration + Math.random() * PAXOS_PROPOSAL_JITTER,
        nodeId: node.id,
      },
    });

    return actions;
  }

  private handlePrepare(node: NodeState, msg: Message): Action[] {
    const { proposalNumber } = msg.payload as { proposalNumber: number };

    if (proposalNumber > (node.meta.minProposal as number)) {
      // Promise: we won't accept any proposal lower than this
      node.meta.minProposal = proposalNumber;

      return [{
        type: 'send_message',
        message: {
          type: 'promise',
          from: node.id,
          to: msg.from,
          term: proposalNumber,
          payload: {
            proposalNumber,
            acceptedProposal: node.meta.acceptedProposal,
            acceptedValue: node.meta.acceptedValue,
          },
        },
      }];
    }

    // NACK: already promised a higher proposal
    return [{
      type: 'send_message',
      message: {
        type: 'nack',
        from: node.id,
        to: msg.from,
        term: node.meta.minProposal as number,
        payload: {
          proposalNumber,
          highestSeen: node.meta.minProposal,
        },
      },
    }];
  }

  // ---- Proposer: Phase 2 — Accept ----

  private handlePromise(node: NodeState, msg: Message): Action[] {
    if (!node.meta.isProposing) return [];
    // Ignore promises if already in Accept phase (late arrivals from slow nodes)
    if (node.meta.proposalPhase !== 'prepare') return [];

    const { proposalNumber, acceptedProposal, acceptedValue } = msg.payload as {
      proposalNumber: number;
      acceptedProposal: number;
      acceptedValue: string | null;
    };

    // Ignore promises for old proposals
    if (proposalNumber !== node.meta.proposalNumber) return [];

    node.votesReceived.add(msg.from);
    node.meta.promisesReceived = (node.meta.promisesReceived as number) + 1;

    // If acceptor already accepted a value with higher proposal, adopt it
    // But ignore values already committed in our log (stale acceptor state from previous slot)
    if (acceptedProposal > (node.meta.highestPromisedProposal as number) && acceptedValue !== null) {
      const alreadyCommitted = node.log.some(e => e.command === acceptedValue && e.committed);
      if (!alreadyCommitted) {
        node.meta.highestPromisedProposal = acceptedProposal;
        node.meta.highestPromisedValue = acceptedValue;
      }
    }

    const peers = node.meta.peers as NodeId[];
    const majority = Math.floor((peers.length + 1) / 2) + 1;

    if ((node.meta.promisesReceived as number) >= majority) {
      // Got quorum of promises — transition to Accept phase
      node.meta.proposalPhase = 'accept';

      // Paxos rule: if any acceptor reported an already-accepted value, use that
      const valueToPropose = (node.meta.highestPromisedValue as string | null)
        ?? (node.meta.pendingValue as string)
        ?? 'noop';

      return this.sendAccept(node, valueToPropose);
    }

    return [];
  }

  private sendAccept(node: NodeState, value: string): Action[] {
    const peers = node.meta.peers as NodeId[];
    const proposalNumber = node.meta.proposalNumber as number;
    const actions: Action[] = [];

    for (const peer of peers) {
      actions.push({
        type: 'send_message',
        message: {
          type: 'accept',
          from: node.id,
          to: peer,
          term: proposalNumber,
          payload: { proposalNumber, value },
        },
      });
    }

    // Self-accept
    node.meta.acceptedProposal = proposalNumber;
    node.meta.acceptedValue = value;
    node.meta.acceptsReceived = 1;

    return actions;
  }

  private handleAccept(node: NodeState, msg: Message): Action[] {
    const { proposalNumber, value } = msg.payload as {
      proposalNumber: number; value: string;
    };

    if (proposalNumber >= (node.meta.minProposal as number)) {
      // Accept the value
      node.meta.minProposal = proposalNumber;
      node.meta.acceptedProposal = proposalNumber;
      node.meta.acceptedValue = value;

      return [{
        type: 'send_message',
        message: {
          type: 'accepted',
          from: node.id,
          to: msg.from,
          term: proposalNumber,
          payload: { proposalNumber, value },
        },
      }];
    }

    // NACK: already promised higher
    return [{
      type: 'send_message',
      message: {
        type: 'nack',
        from: node.id,
        to: msg.from,
        term: node.meta.minProposal as number,
        payload: { proposalNumber, highestSeen: node.meta.minProposal },
      },
    }];
  }

  private handleAccepted(node: NodeState, msg: Message): Action[] {
    if (!node.meta.isProposing) return [];

    const { proposalNumber, value } = msg.payload as {
      proposalNumber: number; value: string;
    };

    if (proposalNumber !== node.meta.proposalNumber) return [];

    node.meta.acceptsReceived = (node.meta.acceptsReceived as number) + 1;

    const peers = node.meta.peers as NodeId[];
    const majority = Math.floor((peers.length + 1) / 2) + 1;

    if ((node.meta.acceptsReceived as number) >= majority) {
      node.meta.acceptsReceived = 0; // prevent re-trigger

      // Check if this value was already committed (race with Learn from another proposer)
      const alreadyCommitted = node.log.some(e => e.command === value && e.committed);

      // Remove committed command from queue
      const queue = node.meta.commandQueue as string[];
      const idx = queue.indexOf(value);
      if (idx !== -1) queue.splice(idx, 1);

      node.meta.isProposing = false;
      node.meta.pendingValue = null;
      node.meta.proposalPhase = null;

      // Reset acceptor state for the next slot (each Paxos instance is independent)
      node.meta.acceptedProposal = -1;
      node.meta.acceptedValue = null;

      const actions: Action[] = [];

      if (!alreadyCommitted) {
        // Value is committed!
        const entry: LogEntry = {
          term: proposalNumber,
          index: node.log.length,
          command: value,
          committed: true,
        };
        node.log.push(entry);
        node.commitIndex = node.log.length - 1;

        actions.push({ type: 'commit_entry' });

        // Broadcast Learn to all peers so they update their logs
        const learnPeers = node.meta.peers as NodeId[];
        for (const peer of learnPeers) {
          actions.push({
            type: 'send_message',
            message: {
              type: 'learn',
              from: node.id,
              to: peer,
              term: proposalNumber,
              payload: { value, proposalNumber, commitIndex: node.commitIndex },
            },
          });
        }
      }

      // If more commands in queue, start next proposal
      if (queue.length > 0) {
        actions.push(...this.startProposal(node));
      } else {
        node.role = 'acceptor';
        // Cancel proposal timeout
        actions.push({
          type: 'cancel_timeout',
          timeout: { type: 'election', duration: 0, nodeId: node.id },
        });
      }

      return actions;
    }

    return [];
  }

  private handleNack(node: NodeState, msg: Message): Action[] {
    if (!node.meta.isProposing) return [];

    const { proposalNumber, highestSeen } = msg.payload as { proposalNumber: number; highestSeen: number };

    // Ignore stale NACKs from old proposal rounds
    if (proposalNumber !== node.meta.proposalNumber) return [];

    // Bump our sequence number above what we've seen
    const nodeCount = (node.meta.peers as NodeId[]).length + 1;
    const nodeIndex = node.meta.nodeIndex as number;
    const minSeq = Math.ceil(((highestSeen as number) - nodeIndex) / nodeCount) + 1;
    if (minSeq > (node.meta.seqNum as number)) {
      node.meta.seqNum = minSeq;
    }

    // Back off with random delay then retry
    node.meta.isProposing = false;
    node.meta.proposalPhase = null;
    node.role = 'acceptor';

    // Backoff proportional to nodeIndex — breaks dueling proposers
    const backoff = PAXOS_NACK_BACKOFF_BASE + nodeIndex * PAXOS_NACK_BACKOFF_PER_NODE + Math.random() * PAXOS_NACK_BACKOFF_JITTER;
    return [{
      type: 'set_timeout',
      timeout: {
        type: 'election',
        duration: backoff,
        nodeId: node.id,
      },
    }];
  }

  // ---- Learn phase — broadcast committed value to all ----

  private handleLearn(node: NodeState, msg: Message): Action[] {
    const { value, proposalNumber } = msg.payload as {
      value: string; proposalNumber: number; commitIndex: number;
    };

    // Add to log if not already there
    const alreadyCommitted = node.log.some(e => e.command === value && e.committed);
    if (!alreadyCommitted) {
      const entry: LogEntry = {
        term: proposalNumber,
        index: node.log.length,
        command: value,
        committed: true,
      };
      node.log.push(entry);
      node.commitIndex = node.log.length - 1;
    }

    // Reset acceptor state for the next slot (each Paxos instance is independent)
    node.meta.acceptedProposal = -1;
    node.meta.acceptedValue = null;

    // Remove from command queue if present (avoids re-proposing already committed values)
    const queue = node.meta.commandQueue as string[];
    const idx = queue.indexOf(value);
    if (idx !== -1) {
      queue.splice(idx, 1);
      // If this was the value we were proposing, stop proposing
      if (node.meta.pendingValue === value) {
        node.meta.isProposing = false;
        node.meta.pendingValue = null;
        node.meta.proposalPhase = null;
        // If more commands remain, start next proposal; otherwise revert to acceptor
        if (queue.length > 0) {
          return this.startProposal(node);
        }
        node.role = 'acceptor';
        return [{
          type: 'cancel_timeout',
          timeout: { type: 'election', duration: 0, nodeId: node.id },
        }];
      }
    }

    return [];
  }

  private randomTimeout(config: ClusterConfig): number {
    return config.electionTimeoutMin + Math.random() * (config.electionTimeoutMax - config.electionTimeoutMin);
  }
}
