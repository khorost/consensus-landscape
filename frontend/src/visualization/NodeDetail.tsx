import React from 'react';
import { NodeState, NodeId } from '../simulation/types';

interface NodeDetailProps {
  node: NodeState | null;
  onKill?: (id: NodeId) => void;
  onRecover?: (id: NodeId) => void;
  onClose?: () => void;
}

export const NodeDetail: React.FC<NodeDetailProps> = React.memo(({ node, onKill, onRecover, onClose }) => {
  if (!node) {
    return (
      <div className="node-detail empty">
        <p className="hint">Нажмите на узел для просмотра деталей</p>
      </div>
    );
  }

  const isAlive = node.status === 'alive';

  return (
    <div className="node-detail">
      <div className="node-detail-header">
        <h4>Узел #{parseInt(node.id.split('_')[1]) + 1}</h4>
        <span className={`status-badge ${node.status}`}>
          {isAlive ? node.role : 'отключён'}
        </span>
        <button className="btn btn-xs node-detail-close" onClick={onClose} title="Закрыть">✕</button>
      </div>

      <div className="node-detail-actions">
        {isAlive ? (
          <button className="btn btn-sm btn-danger" onClick={() => onKill?.(node.id)}>
            Отключить
          </button>
        ) : (
          <button className="btn btn-sm btn-success" onClick={() => onRecover?.(node.id)}>
            Восстановить
          </button>
        )}
      </div>

      <div className="node-detail-info">
        <div className="info-row">
          <span className="info-label">Терм:</span>
          <span className="info-value">{node.currentTerm}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Голос за:</span>
          <span className="info-value">{node.votedFor ?? '—'}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Commit index:</span>
          <span className="info-value">{node.commitIndex}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Записей в логе:</span>
          <span className="info-value">{node.log.length}</span>
        </div>
      </div>

      {node.log.length > 0 && (
        <div className="node-log">
          <h5>Лог</h5>
          <div className="log-entries">
            {node.log.slice(-10).reverse().map((entry, i) => (
              <div
                key={i}
                className={`log-entry ${entry.committed ? 'committed' : 'pending'}`}
              >
                <span className="log-index">{entry.index}</span>
                <span className="log-term">T{entry.term}</span>
                <span className="log-command">{entry.command}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
