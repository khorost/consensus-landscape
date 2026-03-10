import { useState } from 'react';
import { SimulationPanel } from './ui/SimulationPanel';
import { ThemeToggle } from './ui/ThemeToggle';
import { useTheme } from './hooks/useTheme';
import { AlgorithmType } from './hooks/useSimulation';
import { NetworkProfile } from './simulation/constants';
import './App.css';

interface PanelConfig {
  id: string;
  algorithm: AlgorithmType;
  nodeCount: number;
  networkProfile: NetworkProfile;
  clientCount: number;
}

function App() {
  const { preference, cycleTheme } = useTheme();

  const [panels, setPanels] = useState<PanelConfig[]>([
    { id: 'a', algorithm: 'raft', nodeCount: 3, networkProfile: 'wan', clientCount: 2 },
    { id: 'b', algorithm: 'paxos', nodeCount: 5, networkProfile: 'wan', clientCount: 2 },
  ]);

  const updatePanel = (index: number, update: { algorithm: AlgorithmType; nodeCount: number }) => {
    setPanels(prev => prev.map((p, i) =>
      i === index ? { ...p, ...update } : p
    ));
  };

  const addPanel = () => {
    if (panels.length >= 3) return;
    const id = String.fromCharCode(97 + panels.length);
    setPanels(prev => [...prev, { id, algorithm: 'paxos', nodeCount: 5, networkProfile: 'wan', clientCount: 2 }]);
  };

  const removePanel = (index: number) => {
    if (panels.length <= 1) return;
    setPanels(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Consensus Landscape</h1>
        <p className="app-subtitle">Интерактивное сравнение алгоритмов консенсуса</p>
        <div className="header-actions">
          {panels.length < 3 && (
            <button className="btn btn-sm" onClick={addPanel}>
              + Панель
            </button>
          )}
          <ThemeToggle preference={preference} onToggle={cycleTheme} />
        </div>
      </header>

      <main className={`panels-container panels-${panels.length}`}>
        {panels.map((panel, i) => (
          <div key={panel.id} className="panel-wrapper">
            {panels.length > 1 && (
              <button
                className="btn btn-icon panel-close"
                onClick={() => removePanel(i)}
                title="Убрать панель"
              >
                ✕
              </button>
            )}
            <SimulationPanel
              id={panel.id}
              algorithmType={panel.algorithm}
              nodeCount={panel.nodeCount}
              networkProfile={panel.networkProfile}
              clientCount={panel.clientCount}
              onConfigChange={update => updatePanel(i, update)}
            />
          </div>
        ))}
      </main>

      <footer className="app-footer">
        <a href="/consensus-landscape/docs/" className="footer-link" target="_blank" rel="noopener">Документация</a>
        <span className="copyright">Consensus Landscape &copy; {new Date().getFullYear()}</span>
        <span className="build-label" title={`Build ${__BUILD_HASH__} (${__BUILD_DATE__})`}>{__BUILD_REF__}:{__BUILD_HASH__}</span>
      </footer>
    </div>
  );
}

export default App;
