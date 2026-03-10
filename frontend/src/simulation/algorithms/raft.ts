import { ConsensusAlgorithm } from './interface';
import {
  NodeState, NodeId, Message, Action, ClusterConfig, TimeoutType, LogEntry,
} from '../types';
import {
  DEFAULT_ELECTION_TIMEOUT_MIN, DEFAULT_ELECTION_TIMEOUT_MAX, DEFAULT_HEARTBEAT_INTERVAL,
} from '../constants';

export class RaftAlgorithm implements ConsensusAlgorithm {
  readonly name = 'Raft';
  readonly description = 'Leader-based consensus with term-based elections and log replication';

  getInitialState(nodeId: NodeId, config: ClusterConfig): NodeState {
    const allNodes = Array.from({ length: config.nodeCount }, (_, i) => `node_${i}`);
    return {
      id: nodeId,
      role: 'follower',
      status: 'alive',
      currentTerm: 0,
      votedFor: null,
      log: [],
      commitIndex: -1,
      lastApplied: -1,
      nextIndex: new Map(allNodes.map(id => [id, 0])),
      matchIndex: new Map(allNodes.map(id => [id, -1])),
      votesReceived: new Set(),
      meta: {
        peers: allNodes.filter(id => id !== nodeId),
        knownLeader: null as NodeId | null,
        electionTimeoutMin: config.electionTimeoutMin,
        electionTimeoutMax: config.electionTimeoutMax,
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
    if (msg.term > node.currentTerm) {
      node.currentTerm = msg.term;
      node.role = 'follower';
      node.votedFor = null;
      node.votesReceived.clear();
    }

    switch (msg.type) {
      case 'request_vote': return this.handleRequestVote(node, msg);
      case 'request_vote_response': return this.handleRequestVoteResponse(node, msg);
      case 'append_entries': return this.handleAppendEntries(node, msg);
      case 'append_entries_response': return this.handleAppendEntriesResponse(node, msg);
      default: return [];
    }
  }

  onTimeout(node: NodeState, type: TimeoutType): Action[] {
    if (type === 'election') {
      return this.startElection(node);
    }
    if (type === 'heartbeat' && node.role === 'leader') {
      return this.sendHeartbeats(node);
    }
    return [];
  }

  onClientRequest(node: NodeState, command: string): Action[] {
    if (node.role !== 'leader') {
      // Not leader — return redirect response (engine will handle re-routing)
      return [{
        type: 'send_message',
        message: {
          type: 'client_response',
          from: node.id,
          to: node.id, // placeholder — engine intercepts this
          term: node.currentTerm,
          payload: {
            success: false,
            redirect: true,
            leaderHint: (node.meta.knownLeader as NodeId | null),
          },
        },
      }];
    }

    const entry: LogEntry = {
      term: node.currentTerm,
      index: node.log.length,
      command,
      committed: false,
    };
    node.log.push(entry);
    node.matchIndex.set(node.id, node.log.length - 1);

    // Send replication and reset heartbeat timer (avoid duplicate sends)
    const actions = this.sendAppendEntriesToAll(node);
    actions.push({
      type: 'set_timeout',
      timeout: {
        type: 'heartbeat',
        duration: (node.meta.heartbeatInterval as number) ?? DEFAULT_HEARTBEAT_INTERVAL,
        nodeId: node.id,
      },
    });
    return actions;
  }

  onRecovery(node: NodeState, config: ClusterConfig): Action[] {
    node.role = 'follower';
    node.votedFor = null;
    node.votesReceived.clear();
    node.meta.knownLeader = null;

    return [{
      type: 'set_timeout',
      timeout: {
        type: 'election',
        duration: this.randomElectionTimeout(config),
        nodeId: node.id,
      },
    }];
  }

  // ---- Election ----

  private startElection(node: NodeState): Action[] {
    node.currentTerm++;
    node.role = 'candidate';
    node.votedFor = node.id;
    node.votesReceived.clear();
    node.votesReceived.add(node.id);
    node.meta.knownLeader = null;

    const peers = node.meta.peers as NodeId[];
    const actions: Action[] = [];

    for (const peer of peers) {
      const lastLogIndex = node.log.length - 1;
      const lastLogTerm = lastLogIndex >= 0 ? node.log[lastLogIndex].term : 0;

      actions.push({
        type: 'send_message',
        message: {
          type: 'request_vote',
          from: node.id,
          to: peer,
          term: node.currentTerm,
          payload: { candidateId: node.id, lastLogIndex, lastLogTerm },
        },
      });
    }

    actions.push({
      type: 'set_timeout',
      timeout: { type: 'election', duration: this.electionTimeout(node), nodeId: node.id },
    });

    return actions;
  }

  private handleRequestVote(node: NodeState, msg: Message): Action[] {
    const { candidateId, lastLogIndex, lastLogTerm } = msg.payload as {
      candidateId: NodeId; lastLogIndex: number; lastLogTerm: number;
    };

    let voteGranted = false;
    if (msg.term >= node.currentTerm) {
      const logOk = this.isLogUpToDate(node, lastLogIndex, lastLogTerm);
      if ((node.votedFor === null || node.votedFor === candidateId) && logOk) {
        node.votedFor = candidateId;
        voteGranted = true;
      }
    }

    const actions: Action[] = [{
      type: 'send_message',
      message: {
        type: 'request_vote_response',
        from: node.id, to: msg.from, term: node.currentTerm,
        payload: { voteGranted },
      },
    }];

    if (voteGranted) {
      actions.push({
        type: 'set_timeout',
        timeout: { type: 'election', duration: this.electionTimeout(node), nodeId: node.id },
      });
    }
    return actions;
  }

  private handleRequestVoteResponse(node: NodeState, msg: Message): Action[] {
    if (node.role !== 'candidate') return [];

    const { voteGranted } = msg.payload as { voteGranted: boolean };
    if (voteGranted) node.votesReceived.add(msg.from);

    const peers = node.meta.peers as NodeId[];
    const majority = Math.floor((peers.length + 1) / 2) + 1;

    if (node.votesReceived.size >= majority) {
      return this.becomeLeader(node);
    }
    return [];
  }

  private becomeLeader(node: NodeState): Action[] {
    node.role = 'leader';
    node.votesReceived.clear();
    node.meta.knownLeader = node.id;

    const peers = node.meta.peers as NodeId[];
    for (const peer of peers) {
      node.nextIndex.set(peer, node.log.length);
      node.matchIndex.set(peer, -1);
    }

    const actions: Action[] = [
      { type: 'cancel_timeout', timeout: { type: 'election', duration: 0, nodeId: node.id } },
      { type: 'set_timeout', timeout: { type: 'heartbeat', duration: (node.meta.heartbeatInterval as number) ?? DEFAULT_HEARTBEAT_INTERVAL, nodeId: node.id } },
    ];
    actions.push(...this.sendHeartbeats(node));
    return actions;
  }

  // ---- Log replication ----

  private sendHeartbeats(node: NodeState): Action[] {
    // Heartbeats are always empty AppendEntries — just to reset election timers
    // Data replication happens only via onClientRequest
    const actions = this.sendAppendEntriesToAll(node, true);
    actions.push({
      type: 'set_timeout',
      timeout: { type: 'heartbeat', duration: (node.meta.heartbeatInterval as number) ?? DEFAULT_HEARTBEAT_INTERVAL, nodeId: node.id },
    });
    return actions;
  }

  /**
   * Send AppendEntries to all peers.
   * @param heartbeatOnly — if true, always send empty entries (heartbeat pings)
   */
  private sendAppendEntriesToAll(node: NodeState, heartbeatOnly = false): Action[] {
    const peers = node.meta.peers as NodeId[];
    const actions: Action[] = [];

    for (const peer of peers) {
      const nextIdx = node.nextIndex.get(peer) ?? 0;
      const prevLogIndex = nextIdx - 1;
      const prevLogTerm = prevLogIndex >= 0 && prevLogIndex < node.log.length
        ? node.log[prevLogIndex].term : 0;
      const entries = heartbeatOnly ? [] : node.log.slice(nextIdx);

      actions.push({
        type: 'send_message',
        message: {
          type: 'append_entries',
          from: node.id, to: peer, term: node.currentTerm,
          payload: { leaderId: node.id, prevLogIndex, prevLogTerm, entries: entries.map(e => ({ ...e })), leaderCommit: node.commitIndex },
        },
      });
    }
    return actions;
  }

  private handleAppendEntries(node: NodeState, msg: Message): Action[] {
    const { leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = msg.payload as {
      leaderId: NodeId; prevLogIndex: number; prevLogTerm: number; entries: LogEntry[]; leaderCommit: number;
    };

    let success = false;

    if (msg.term >= node.currentTerm) {
      node.role = 'follower';
      node.votesReceived.clear();
      node.meta.knownLeader = leaderId; // remember who the leader is

      if (prevLogIndex === -1 ||
          (prevLogIndex < node.log.length && node.log[prevLogIndex].term === prevLogTerm)) {
        success = true;

        let insertIdx = prevLogIndex + 1;
        for (const entry of entries) {
          if (insertIdx < node.log.length) {
            if (node.log[insertIdx].term !== entry.term) {
              node.log.splice(insertIdx);
              node.log.push({ ...entry });
            }
          } else {
            node.log.push({ ...entry });
          }
          insertIdx++;
        }

        if (leaderCommit > node.commitIndex) {
          const lastNewIndex = prevLogIndex + entries.length;
          node.commitIndex = Math.min(leaderCommit, lastNewIndex);
          for (let i = 0; i <= node.commitIndex && i < node.log.length; i++) {
            node.log[i].committed = true;
          }
        }
      }
    }

    const isHeartbeat = entries.length === 0;
    const actions: Action[] = [{
      type: 'send_message',
      message: {
        type: 'append_entries_response',
        from: node.id, to: msg.from, term: node.currentTerm,
        payload: { success, matchIndex: success ? node.log.length - 1 : -1, isHeartbeat },
      },
    }];

    if (msg.term >= node.currentTerm) {
      actions.push({
        type: 'set_timeout',
        timeout: { type: 'election', duration: this.electionTimeout(node), nodeId: node.id },
      });
    }
    return actions;
  }

  private handleAppendEntriesResponse(node: NodeState, msg: Message): Action[] {
    if (node.role !== 'leader') return [];
    const { success, matchIndex } = msg.payload as { success: boolean; matchIndex: number };

    if (success) {
      node.nextIndex.set(msg.from, matchIndex + 1);
      node.matchIndex.set(msg.from, matchIndex);
      return this.tryAdvanceCommitIndex(node);
    } else {
      const nextIdx = (node.nextIndex.get(msg.from) ?? 1) - 1;
      node.nextIndex.set(msg.from, Math.max(0, nextIdx));
      const prevLogIndex = nextIdx - 1;
      const prevLogTerm = prevLogIndex >= 0 && prevLogIndex < node.log.length
        ? node.log[prevLogIndex].term : 0;
      const entries = node.log.slice(Math.max(0, nextIdx));
      return [{
        type: 'send_message',
        message: {
          type: 'append_entries',
          from: node.id, to: msg.from, term: node.currentTerm,
          payload: { leaderId: node.id, prevLogIndex: Math.max(-1, prevLogIndex), prevLogTerm, entries: entries.map(e => ({ ...e })), leaderCommit: node.commitIndex },
        },
      }];
    }
  }

  private tryAdvanceCommitIndex(node: NodeState): Action[] {
    const peers = node.meta.peers as NodeId[];
    const totalNodes = peers.length + 1;
    const majority = Math.floor(totalNodes / 2) + 1;

    for (let n = node.log.length - 1; n > node.commitIndex; n--) {
      if (node.log[n].term !== node.currentTerm) continue;
      let count = 1;
      for (const peer of peers) {
        if ((node.matchIndex.get(peer) ?? -1) >= n) count++;
      }
      if (count >= majority) {
        node.commitIndex = n;
        for (let i = 0; i <= n; i++) node.log[i].committed = true;
        return [{ type: 'commit_entry' }];
      }
    }
    return [];
  }

  private isLogUpToDate(node: NodeState, lastLogIndex: number, lastLogTerm: number): boolean {
    const myLastIndex = node.log.length - 1;
    const myLastTerm = myLastIndex >= 0 ? node.log[myLastIndex].term : 0;
    if (lastLogTerm !== myLastTerm) return lastLogTerm > myLastTerm;
    return lastLogIndex >= myLastIndex;
  }

  /** Election timeout from node's stored config */
  private electionTimeout(node: NodeState): number {
    const min = (node.meta.electionTimeoutMin as number) ?? DEFAULT_ELECTION_TIMEOUT_MIN;
    const max = (node.meta.electionTimeoutMax as number) ?? DEFAULT_ELECTION_TIMEOUT_MAX;
    return min + Math.random() * (max - min);
  }

  private randomElectionTimeout(config: ClusterConfig): number {
    return config.electionTimeoutMin + Math.random() * (config.electionTimeoutMax - config.electionTimeoutMin);
  }
}
