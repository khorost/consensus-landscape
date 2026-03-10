import React from 'react';
import { LiveStats } from '../simulation/types';

interface StatsBarProps {
  stats: LiveStats;
  algorithmName: string;
}

export const StatsBar: React.FC<StatsBarProps> = React.memo(({ stats, algorithmName }) => {
  const isPaxos = algorithmName === 'paxos';

  return (
    <div className="stats-bar">
      <div className="stat-item" title="Текущий лидер">
        <span className="stat-icon">♚</span>
        <span className="stat-value">
          {stats.currentLeader ? `#${parseInt(stats.currentLeader.split('_')[1]) + 1}` : '—'}
        </span>
      </div>

      <div className="stat-item" title="Текущий терм / раунд">
        <span className="stat-label">T</span>
        <span className="stat-value">{stats.currentTerm}</span>
      </div>

      <div className="stat-item" title="Подтверждённых записей">
        <span className="stat-icon">✓</span>
        <span className="stat-value">{stats.totalCommits}</span>
      </div>

      <div className="stat-item" title="Всего сообщений / потеряно">
        <span className="stat-icon">✉</span>
        <span className="stat-value">
          {stats.totalMessages}
          {stats.droppedMessages > 0 && (
            <span className="stat-warn"> (-{stats.droppedMessages})</span>
          )}
        </span>
      </div>

      <div className="stat-item stat-latency" title="Средняя задержка подтверждения">
        <span className="stat-icon">⏱</span>
        <span className="stat-value">
          {stats.avgLatency > 0 ? stats.avgLatency.toFixed(0) + ' мс' : '—'}
        </span>
      </div>

      <div className="stat-item" title="Смен лидера">
        <span className="stat-icon">↺</span>
        <span className="stat-value">{stats.leaderChanges}</span>
      </div>

      {isPaxos && (
        <div className="stat-item" title="Отклонения (NACK) — конфликты кворума">
          <span className="stat-icon stat-nack">✗</span>
          <span className="stat-value">
            {stats.nackCount}
          </span>
        </div>
      )}

      {stats.electionTime !== null && (
        <div className="stat-item" title={isPaxos ? 'Время до первого коммита' : 'Время выбора лидера'}>
          <span className="stat-icon">⚡</span>
          <span className="stat-value">{stats.electionTime.toFixed(0)} мс</span>
        </div>
      )}

      {stats.rejectedRequests > 0 && (
        <div className="stat-item" title="Отклонённых клиентских запросов">
          <span className="stat-icon stat-nack">⊘</span>
          <span className="stat-value">{stats.rejectedRequests}</span>
        </div>
      )}

      <div className="stat-item stat-quorum" title="Размер кворума">
        <span className="stat-label">Q</span>
        <span className="stat-value">{stats.quorumSize}</span>
      </div>
    </div>
  );
});
