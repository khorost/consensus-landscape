import { NetworkConfig, NodeId } from './types';

export class NetworkModel {
  private config: NetworkConfig;

  constructor(config: NetworkConfig) {
    this.config = config;
  }

  updateConfig(config: NetworkConfig): void {
    this.config = config;
  }

  /** Get network delay between two nodes */
  getDelay(from: NodeId, to: NodeId, rng: () => number): number {
    const { minDelay, maxDelay } = this.config;
    // Uniform distribution between min and max
    return minDelay + rng() * (maxDelay - minDelay);
  }

  /** Check if a message should be dropped */
  isDropped(from: NodeId, to: NodeId, rng: () => number): boolean {
    // Check if nodes are in different partitions
    if (this.arePartitioned(from, to)) return true;
    // Random packet loss
    return rng() < this.config.packetLossRate;
  }

  /** Check if two nodes are separated by a network partition */
  arePartitioned(from: NodeId, to: NodeId): boolean {
    if (this.config.partitions.length === 0) return false;

    let fromPartition = -1;
    let toPartition = -1;

    for (let i = 0; i < this.config.partitions.length; i++) {
      if (this.config.partitions[i].includes(from)) fromPartition = i;
      if (this.config.partitions[i].includes(to)) toPartition = i;
    }

    // If both nodes are assigned to partitions and they differ, they're partitioned
    if (fromPartition !== -1 && toPartition !== -1 && fromPartition !== toPartition) {
      return true;
    }

    return false;
  }
}
