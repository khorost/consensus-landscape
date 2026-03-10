import { describe, it, expect } from 'vitest';
import { NetworkModel } from './network';
import { NetworkConfig } from './types';

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    minDelay: 10,
    maxDelay: 50,
    packetLossRate: 0,
    partitions: [],
    ...overrides,
  };
}

const fixedRng = (v: number) => () => v;

describe('NetworkModel', () => {
  describe('getDelay', () => {
    it('returns minDelay when rng returns 0', () => {
      const net = new NetworkModel(makeConfig({ minDelay: 10, maxDelay: 50 }));
      expect(net.getDelay('a', 'b', fixedRng(0))).toBe(10);
    });

    it('returns maxDelay when rng returns 1', () => {
      const net = new NetworkModel(makeConfig({ minDelay: 10, maxDelay: 50 }));
      expect(net.getDelay('a', 'b', fixedRng(1))).toBe(50);
    });

    it('interpolates linearly', () => {
      const net = new NetworkModel(makeConfig({ minDelay: 0, maxDelay: 100 }));
      expect(net.getDelay('a', 'b', fixedRng(0.5))).toBe(50);
    });
  });

  describe('isDropped', () => {
    it('does not drop when packetLossRate is 0', () => {
      const net = new NetworkModel(makeConfig({ packetLossRate: 0 }));
      expect(net.isDropped('a', 'b', fixedRng(0.5))).toBe(false);
    });

    it('drops when rng < packetLossRate', () => {
      const net = new NetworkModel(makeConfig({ packetLossRate: 0.5 }));
      expect(net.isDropped('a', 'b', fixedRng(0.3))).toBe(true);
    });

    it('does not drop when rng >= packetLossRate', () => {
      const net = new NetworkModel(makeConfig({ packetLossRate: 0.3 }));
      expect(net.isDropped('a', 'b', fixedRng(0.5))).toBe(false);
    });

    it('drops when nodes are in different partitions', () => {
      const net = new NetworkModel(makeConfig({
        partitions: [['a', 'b'], ['c', 'd']],
      }));
      expect(net.isDropped('a', 'c', fixedRng(0))).toBe(true);
    });

    it('does not drop when nodes are in the same partition', () => {
      const net = new NetworkModel(makeConfig({
        partitions: [['a', 'b'], ['c', 'd']],
      }));
      expect(net.isDropped('a', 'b', fixedRng(0))).toBe(false);
    });
  });

  describe('arePartitioned', () => {
    it('returns false with no partitions', () => {
      const net = new NetworkModel(makeConfig());
      expect(net.arePartitioned('a', 'b')).toBe(false);
    });

    it('returns true for nodes in different partitions', () => {
      const net = new NetworkModel(makeConfig({
        partitions: [['node_0', 'node_1'], ['node_2']],
      }));
      expect(net.arePartitioned('node_0', 'node_2')).toBe(true);
    });

    it('returns false if one node is not in any partition', () => {
      const net = new NetworkModel(makeConfig({
        partitions: [['node_0']],
      }));
      expect(net.arePartitioned('node_0', 'node_1')).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('applies new config', () => {
      const net = new NetworkModel(makeConfig({ minDelay: 10, maxDelay: 50 }));
      net.updateConfig(makeConfig({ minDelay: 100, maxDelay: 200 }));
      expect(net.getDelay('a', 'b', fixedRng(0))).toBe(100);
    });
  });
});
