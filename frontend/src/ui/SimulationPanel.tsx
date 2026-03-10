import { useState, useCallback } from 'react';
import { ClusterView } from '../visualization/ClusterView';
import { TimelineControl } from '../visualization/TimelineControl';
import { NodeDetail } from '../visualization/NodeDetail';
import { StatsBar } from '../visualization/StatsBar';
import { LatencyChart } from '../visualization/LatencyChart';
import { useSimulation, AlgorithmType } from '../hooks/useSimulation';
import { NodeId } from '../simulation/types';
import { NetworkProfile, NETWORK_PROFILES } from '../simulation/constants';

interface SimulationPanelProps {
  id: string;
  algorithmType: AlgorithmType;
  nodeCount: number;
  networkProfile: NetworkProfile;
  clientCount: number;
  onConfigChange?: (config: {
    algorithm: AlgorithmType;
    nodeCount: number;
    networkProfile: NetworkProfile;
    clientCount: number;
  }) => void;
}

export const SimulationPanel: React.FC<SimulationPanelProps> = ({
  id,
  algorithmType,
  nodeCount,
  networkProfile,
  clientCount,
  onConfigChange,
}) => {
  const [selectedNode, setSelectedNode] = useState<NodeId | null>(null);
  const [clientCmd, setClientCmd] = useState('');

  const seed = 42 + id.charCodeAt(0);
  const cfg = { algorithm: algorithmType, nodeCount, networkProfile, clientCount };

  const {
    state, play, pause, step, reset,
    setSpeed, killNode, recoverNode, submitRequest,
  } = useSimulation(algorithmType, nodeCount, seed, networkProfile, clientCount);

  const handleNodeClick = useCallback((nodeId: NodeId) => {
    setSelectedNode(prev => prev === nodeId ? null : nodeId);
  }, []);

  const handleSubmit = useCallback(() => {
    if (clientCmd.trim()) {
      submitRequest(clientCmd.trim());
      setClientCmd('');
    }
  }, [clientCmd, submitRequest]);

  const selectedNodeState = selectedNode ? state.nodes.get(selectedNode) ?? null : null;

  return (
    <div className="simulation-panel">
      <div className="panel-header">
        <div className="panel-title-row">
          <select
            value={algorithmType}
            onChange={e => onConfigChange?.({ ...cfg, algorithm: e.target.value as AlgorithmType })}
            className="select-algorithm"
          >
            <option value="raft">Raft</option>
            <option value="paxos">Basic Paxos</option>
            <option value="multi-paxos">Multi-Paxos</option>
            <option value="zab">Zab (ZooKeeper)</option>
            <option value="epaxos">EPaxos</option>
          </select>

          <select
            value={nodeCount}
            onChange={e => onConfigChange?.({ ...cfg, nodeCount: Number(e.target.value) })}
            className="select-nodes"
          >
            {[3, 5, 7, 9].map(n => (
              <option key={n} value={n}>{n} узлов</option>
            ))}
          </select>

          <select
            value={networkProfile}
            onChange={e => onConfigChange?.({ ...cfg, networkProfile: e.target.value as NetworkProfile })}
            className="select-profile"
          >
            {(Object.entries(NETWORK_PROFILES) as [NetworkProfile, { label: string }][]).map(([key, p]) => (
              <option key={key} value={key}>{p.label}</option>
            ))}
          </select>

          <select
            value={clientCount}
            onChange={e => onConfigChange?.({ ...cfg, clientCount: Number(e.target.value) })}
            className="select-clients"
          >
            {[1, 2, 3, 4, 5].map(n => (
              <option key={n} value={n}>{n} кл.</option>
            ))}
          </select>
        </div>

        <StatsBar stats={state.liveStats} algorithmName={algorithmType} />
      </div>

      <LatencyChart metrics={state.metrics} currentTime={state.time} />

      <div className="panel-visualization">
        <ClusterView
          nodes={state.nodes}
          activeMessages={state.activeMessages}
          clients={state.clients}
          currentTime={state.time}
          onNodeClick={handleNodeClick}
          timeoutProgress={state.timeoutProgress}
          clientConnections={state.clientConnections}
          autoClientTiming={state.autoClientTiming}
        />
      </div>

      <TimelineControl
        time={state.time}
        isRunning={state.isRunning}
        speed={state.speed}
        onPlay={play}
        onPause={pause}
        onStep={step}
        onReset={reset}
        onSpeedChange={setSpeed}
      />

      <div className="panel-bottom">
        <div className="client-input">
          <input
            type="text"
            value={clientCmd}
            onChange={e => setClientCmd(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="Команда клиента..."
            className="input"
          />
          <button onClick={handleSubmit} className="btn btn-sm btn-primary">
            Отправить
          </button>
        </div>

        <NodeDetail
          node={selectedNodeState}
          onKill={killNode}
          onRecover={recoverNode}
          onClose={() => setSelectedNode(null)}
        />
      </div>

      <div className="panel-legend">
        {algorithmType === 'raft' && (
          <>
            <div className="legend">
              <span className="legend-item"><span className="legend-dot follower" /> Follower</span>
              <span className="legend-item"><span className="legend-dot candidate" /> Candidate</span>
              <span className="legend-item"><span className="legend-dot leader" /> Leader</span>
              <span className="legend-item"><span className="legend-dot dead" /> Отключён</span>
            </div>
            <div className="legend">
              <span className="legend-item"><span className="legend-shape msg-square-client" /> Клиент</span>
              <span className="legend-item"><span className="legend-shape msg-diamond" /> Голосование</span>
              <span className="legend-item"><span className="legend-shape msg-circle" /> Heartbeat</span>
              <span className="legend-item"><span className="legend-shape msg-square-repl" /> Репликация</span>
            </div>
          </>
        )}
        {algorithmType === 'paxos' && (
          <>
            <div className="legend">
              <span className="legend-item"><span className="legend-dot follower" /> Acceptor</span>
              <span className="legend-item"><span className="legend-dot candidate" /> Proposer</span>
              <span className="legend-item"><span className="legend-dot dead" /> Отключён</span>
            </div>
            <div className="legend">
              <span className="legend-item"><span className="legend-shape msg-square-client" /> Клиент</span>
              <span className="legend-item"><span className="legend-shape msg-diamond" /><span className="legend-shape-label">P</span> Prepare</span>
              <span className="legend-item"><span className="legend-shape msg-square-accept" /><span className="legend-shape-label">A</span> Accept</span>
              <span className="legend-item"><span className="legend-shape msg-circle" /><span className="legend-shape-label">L</span> Learn</span>
              <span className="legend-item"><span className="legend-shape msg-nack" /> NACK</span>
            </div>
          </>
        )}
        {algorithmType === 'multi-paxos' && (
          <>
            <div className="legend">
              <span className="legend-item"><span className="legend-dot follower" /> Follower</span>
              <span className="legend-item"><span className="legend-dot candidate" /> Candidate</span>
              <span className="legend-item"><span className="legend-dot leader" /> Leader</span>
              <span className="legend-item"><span className="legend-dot dead" /> Отключён</span>
            </div>
            <div className="legend">
              <span className="legend-item"><span className="legend-shape msg-square-client" /> Клиент</span>
              <span className="legend-item"><span className="legend-shape msg-diamond" /><span className="legend-shape-label">P</span> Prepare</span>
              <span className="legend-item"><span className="legend-shape msg-square-accept" /><span className="legend-shape-label">A</span> Accept</span>
              <span className="legend-item"><span className="legend-shape msg-circle" /> Heartbeat</span>
              <span className="legend-item"><span className="legend-shape msg-circle" /><span className="legend-shape-label">L</span> Learn</span>
            </div>
          </>
        )}
        {algorithmType === 'zab' && (
          <>
            <div className="legend">
              <span className="legend-item"><span className="legend-dot candidate" /> Looking</span>
              <span className="legend-item"><span className="legend-dot follower" /> Following</span>
              <span className="legend-item"><span className="legend-dot leader" /> Leading</span>
              <span className="legend-item"><span className="legend-dot dead" /> Отключён</span>
            </div>
            <div className="legend">
              <span className="legend-item"><span className="legend-shape msg-square-client" /> Клиент</span>
              <span className="legend-item"><span className="legend-shape msg-diamond" /><span className="legend-shape-label">E</span> Election</span>
              <span className="legend-item"><span className="legend-shape msg-square-repl" /><span className="legend-shape-label">P</span> Proposal</span>
              <span className="legend-item"><span className="legend-shape msg-circle" /><span className="legend-shape-label">C</span> Commit</span>
              <span className="legend-item"><span className="legend-shape msg-circle" /> Heartbeat</span>
            </div>
          </>
        )}
        {algorithmType === 'epaxos' && (
          <>
            <div className="legend">
              <span className="legend-item"><span className="legend-dot follower" /> Replica</span>
              <span className="legend-item"><span className="legend-dot dead" /> Отключён</span>
            </div>
            <div className="legend">
              <span className="legend-item"><span className="legend-shape msg-square-client" /> Клиент</span>
              <span className="legend-item"><span className="legend-shape msg-triangle" /> PreAccept (fast)</span>
              <span className="legend-item"><span className="legend-shape msg-diamond" /><span className="legend-shape-label">A</span> Accept (slow)</span>
              <span className="legend-item"><span className="legend-shape msg-circle" /><span className="legend-shape-label">C</span> Commit</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
