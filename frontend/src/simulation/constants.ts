/**
 * Timing constants for the consensus simulation.
 * All duration values are in virtual milliseconds unless noted otherwise.
 *
 * Virtual time flows independently of wall-clock time; the speed multiplier
 * in the UI controls how many virtual ms pass per real ms.
 */

// ============================================================================
// Network
// ============================================================================

/** Minimum one-way message delivery delay between any two nodes. */
export const NETWORK_MIN_DELAY = 30;

/** Maximum one-way message delivery delay between any two nodes. */
export const NETWORK_MAX_DELAY = 100;

// ============================================================================
// Network profiles — presets for different deployment scenarios
// ============================================================================

export type NetworkProfile = 'lan' | 'wan' | 'global';

export interface NetworkProfileConfig {
  label: string;
  minDelay: number;
  maxDelay: number;
  electionTimeoutMin: number;
  electionTimeoutMax: number;
  heartbeatInterval: number;
  /** Auto-client command interval (virtual ms between auto-generated commands). */
  autoClientInterval: number;
  /** Minimum virtual time before first auto-client command. */
  autoClientStartDelay: number;
}

export const NETWORK_PROFILES: Record<NetworkProfile, NetworkProfileConfig> = {
  lan: {
    label: 'Внутри ДЦ',
    minDelay: 1,
    maxDelay: 5,
    electionTimeoutMin: 50,
    electionTimeoutMax: 100,
    heartbeatInterval: 20,
    autoClientInterval: 200,
    autoClientStartDelay: 150,
  },
  wan: {
    label: 'Между ДЦ',
    minDelay: 30,
    maxDelay: 100,
    electionTimeoutMin: 300,
    electionTimeoutMax: 600,
    heartbeatInterval: 100,
    autoClientInterval: 500,
    autoClientStartDelay: 800,
  },
  global: {
    label: 'Между регионами',
    minDelay: 100,
    maxDelay: 300,
    electionTimeoutMin: 1000,
    electionTimeoutMax: 2000,
    heartbeatInterval: 300,
    autoClientInterval: 1500,
    autoClientStartDelay: 2500,
  },
};

// ============================================================================
// Raft — election & heartbeat
// ============================================================================
// Election timeout is randomised within [MIN, MAX] per node.
// The wide range ensures that after a failed election (split vote)
// nodes will retry at sufficiently different moments so one candidate
// collects a majority before the others time out again.
//
// Heartbeat interval must be significantly shorter than the election
// timeout so that followers don't start unnecessary elections while the
// leader is alive.
// ============================================================================

/** Lower bound of the randomised election timeout. */
export const DEFAULT_ELECTION_TIMEOUT_MIN = 300;

/** Upper bound of the randomised election timeout. */
export const DEFAULT_ELECTION_TIMEOUT_MAX = 600;

/**
 * How often the leader sends empty AppendEntries (heartbeats) to followers.
 * Must satisfy: HEARTBEAT_INTERVAL << ELECTION_TIMEOUT_MIN
 * so followers reset their election timer well before it fires.
 */
export const DEFAULT_HEARTBEAT_INTERVAL = 100;

// ============================================================================
// Paxos — proposal timeouts
// ============================================================================
// When a proposer starts a new Prepare round, it sets a timeout to detect
// a stalled round.  The timeout is deliberately non-uniform across nodes:
//
//   timeout = BASE + nodeIndex * PER_NODE_INCREMENT + random(0, JITTER)
//
// A lower-indexed node retries sooner, which breaks the symmetry of
// "dueling proposers" — two nodes continuously pre-empting each other.
// ============================================================================

/** Fixed component of the proposal timeout. */
export const PAXOS_PROPOSAL_BASE_TIMEOUT = 200;

/** Extra delay added per unit of node index (node_0 adds 0, node_1 adds 80, …). */
export const PAXOS_PROPOSAL_PER_NODE_INCREMENT = 80;

/** Random component added on top: uniform in [0, JITTER). */
export const PAXOS_PROPOSAL_JITTER = 150;

// ============================================================================
// Paxos — NACK backoff
// ============================================================================
// When a proposer receives a NACK (its proposal number is stale), it bumps
// the sequence number and backs off before retrying.  The same non-uniform
// strategy is used:
//
//   backoff = BASE + nodeIndex * PER_NODE + random(0, JITTER)
//
// Higher-indexed nodes wait longer, giving lower-indexed nodes a head start.
// ============================================================================

/** Fixed component of the NACK backoff delay. */
export const PAXOS_NACK_BACKOFF_BASE = 200;

/** Extra delay per unit of node index. */
export const PAXOS_NACK_BACKOFF_PER_NODE = 120;

/** Random component: uniform in [0, JITTER). */
export const PAXOS_NACK_BACKOFF_JITTER = 100;

// ============================================================================
// Engine — commit tracking & client retry
// ============================================================================

/**
 * Number of most recent commit latencies kept for the rolling average
 * shown in the StatsBar.
 */
export const LATENCY_WINDOW_SIZE = 20;

/**
 * Maximum number of data points retained in metrics arrays
 * (commitTimestamps, commitLatencies, conflictTimestamps).
 * Older entries are discarded to bound memory during long simulations.
 * Also limits node log length (only last N committed entries kept).
 */
export const METRICS_HISTORY_LIMIT = 500;

/**
 * Maximum committed log entries kept per node.
 * Older committed entries are trimmed (uncommitted are always kept).
 */
export const NODE_LOG_LIMIT = 200;

/**
 * When a client request is rejected and no leader hint is available
 * (election in progress), the engine waits an extra
 *   BASE + random(0, JITTER)
 * before retrying to another node.  This prevents a redirect storm
 * during leader elections.
 */
export const CLIENT_RETRY_DELAY_BASE = 200;
export const CLIENT_RETRY_DELAY_JITTER = 200;

/**
 * When a client request arrives at a dead node, the engine retries
 * to a random alive node after this fixed delay (simulates a TCP
 * connection timeout on the client side).
 */
export const DEAD_NODE_RETRY_DELAY = 100;

/**
 * Fraction of travel time at which a message is logically delivered
 * (visually reaching the node edge rather than center).
 * The animation dot flies from source center, and at this fraction
 * the message triggers the algorithm handler. The dot continues
 * briefly to the center for visual smoothness.
 */
export const MESSAGE_EDGE_DELIVERY_FRACTION = 0.85;

// ============================================================================
// Animation loop & auto-client
// ============================================================================

/**
 * Maximum real-time delta (in real ms, not virtual) accepted per
 * animation frame.  Prevents huge jumps when the browser tab was
 * backgrounded or the frame rate dropped.
 */
export const MAX_FRAME_DELTA_MS = 100;

/**
 * Virtual-time interval between automatically generated client
 * write commands.  Commands are distributed round-robin across all
 * active clients.
 */
export const AUTO_CLIENT_INTERVAL = 500;

/**
 * Minimum virtual time before the first auto-client command is
 * injected.  Must be greater than DEFAULT_ELECTION_TIMEOUT_MAX plus
 * a network round-trip so the initial leader election completes
 * before the first write arrives.
 */
export const AUTO_CLIENT_START_DELAY = 800;
