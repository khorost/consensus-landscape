import React, { useCallback } from 'react';

interface TimelineControlProps {
  time: number;
  isRunning: boolean;
  speed: number;
  onPlay: () => void;
  onPause: () => void;
  onStep: () => void;
  onReset: () => void;
  onSpeedChange: (speed: number) => void;
}

// Logarithmic speed scale: slider 0..100 maps to 0.01x..50x
// Left side = slow (for detailed observation), right side = fast simulation
const SPEED_MIN_LOG = Math.log(0.01);
const SPEED_MAX_LOG = Math.log(50);

function sliderToSpeed(value: number): number {
  const t = value / 100;
  return Math.exp(SPEED_MIN_LOG + t * (SPEED_MAX_LOG - SPEED_MIN_LOG));
}

function speedToSlider(speed: number): number {
  const t = (Math.log(speed) - SPEED_MIN_LOG) / (SPEED_MAX_LOG - SPEED_MIN_LOG);
  return Math.round(t * 100);
}

function formatSpeed(speed: number): string {
  if (speed < 0.1) return speed.toFixed(2) + 'x';
  if (speed < 1) return speed.toFixed(1) + 'x';
  if (speed < 10) return speed.toFixed(1) + 'x';
  return Math.round(speed) + 'x';
}

const PRESETS = [0.05, 0.2, 1, 5, 20];

export const TimelineControl: React.FC<TimelineControlProps> = React.memo(({
  time, isRunning, speed,
  onPlay, onPause, onStep, onReset, onSpeedChange,
}) => {
  const handleSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onSpeedChange(sliderToSpeed(Number(e.target.value)));
  }, [onSpeedChange]);

  return (
    <div className="timeline-control">
      <div className="timeline-buttons">
        <button onClick={onReset} title="Сброс" className="btn btn-icon">
          ⏹
        </button>
        {isRunning ? (
          <button onClick={onPause} title="Пауза" className="btn btn-icon btn-primary">
            ⏸
          </button>
        ) : (
          <button onClick={onPlay} title="Запуск" className="btn btn-icon btn-primary">
            ▶
          </button>
        )}
        <button onClick={onStep} title="Шаг" className="btn btn-icon" disabled={isRunning}>
          ⏭
        </button>
      </div>

      <div className="timeline-speed">
        <span className="speed-label-left">медленно</span>
        <input
          type="range"
          min={0}
          max={100}
          value={speedToSlider(speed)}
          onChange={handleSlider}
          className="speed-slider"
          title={formatSpeed(speed)}
        />
        <span className="speed-label-right">быстро</span>
        <span className="speed-value">{formatSpeed(speed)}</span>
      </div>

      <div className="timeline-presets">
        {PRESETS.map(s => (
          <button
            key={s}
            onClick={() => onSpeedChange(s)}
            className={`btn btn-xs ${Math.abs(speed - s) < 0.05 ? 'btn-active' : ''}`}
          >
            {s < 1 ? s.toFixed(1) : s}x
          </button>
        ))}
      </div>

      <div className="timeline-time">
        <span className="time-value">{formatTime(time)}</span>
      </div>
    </div>
  );
});

function formatTime(ms: number): string {
  if (ms < 1000) return ms.toFixed(0) + ' мс';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' с';
  return (ms / 60000).toFixed(1) + ' мин';
}
