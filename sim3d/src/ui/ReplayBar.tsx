import { useMemo, useRef, useState } from 'react';
import { useSimSnapshot } from '../app/hooks';
import { downloadText, markersOf, nextIncident, parseEventLog, seekEngine, verifyRecording, type LoadedLog, type LogComparison, type Marker } from '../app/replay';
import { engine, scenario } from '../app/simContext';
import { useUI } from '../app/uiStore';

const KIND_LABEL: Record<Marker['kind'], string> = { fault: 'Fault', failure: 'Failure', recovery: 'Recovery', delivery: 'Delivery' };

function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Replay viewer (TC-13): a timeline over the scenario window with fault / failure / recovery markers, seek by
 * re-simulation (the run is deterministic, AT-01), jump to the next incident, and load / verify / save the JSONL log.
 */
export function ReplayBar() {
  const s = useSimSnapshot();
  const setReplay = useUI((u) => u.setReplay);
  const [loaded, setLoaded] = useState<LoadedLog | null>(null);
  const [verdict, setVerdict] = useState<LogComparison | null>(null);
  const [seeking, setSeeking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const duration = Math.max(scenario.duration_s ?? 900, loaded?.endT ?? 0, s.time);
  // markers: the loaded recording if any, else what this run has produced so far (re-read at the 5 Hz snapshot rate)
  const markers = useMemo(() => markersOf(loaded ? loaded.events : engine.events), [loaded, loaded ? 0 : Math.floor(s.time)]);
  const incidents = markers.filter((m) => m.kind !== 'delivery');
  const deliveries = markers.length - incidents.length;

  const seek = async (t: number) => {
    if (seeking !== null) return;
    const wasRunning = engine.status === 'running';
    setSeeking(0);
    try {
      await seekEngine(engine, Math.min(Math.max(0, t), duration), (f) => setSeeking(f));
    } finally {
      setSeeking(null);
      if (wasRunning) engine.resume();
    }
  };

  const tAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * duration;
  };

  const onFile = async (f: File) => {
    setError(null);
    setVerdict(null);
    try {
      const log = parseEventLog(await f.text());
      if (log.scenario && log.scenario !== scenario.name) {
        setError(`This log is from scenario "${log.scenario}". Open ?scenario=${log.scenario}&replay to replay it.`);
        return;
      }
      setLoaded(log);
      // verify: re-simulate the recorded span, then compare line by line
      setSeeking(0);
      try {
        setVerdict(await verifyRecording(engine, log, (f) => setSeeking(f)));
      } finally {
        setSeeking(null);
      }
    } catch (e) {
      setError(`Could not read ${f.name}: ${(e as Error).message}`);
    }
  };

  const save = () => downloadText(`${scenario.name}__${engine.system}__s${scenario.seed ?? 0}__t${Math.round(engine.time)}.jsonl`, engine.exportEventsJsonl());

  const next = nextIncident(markers, s.time);
  const pct = (t: number) => `${(Math.min(t, duration) / duration) * 100}%`;
  const playLabel = s.status === 'running' ? 'Pause' : s.status === 'idle' ? 'Play' : 'Resume';

  return (
    <div className="replay" aria-label="Replay timeline">
      <div className="replay-row">
        <span className="replay-tag">Replay</span>
        <button className="btn sq" title="Back to the start (re-simulates)" disabled={seeking !== null} onClick={() => seek(0)}>
          ⏮
        </button>
        <button className="btn sq" title="Back 10 s" disabled={seeking !== null} onClick={() => seek(s.time - 10)}>
          −10
        </button>
        <button
          className={`btn primary ${s.status === 'running' ? 'on' : ''}`}
          disabled={seeking !== null}
          onClick={() => (s.status === 'idle' ? engine.start() : s.status === 'running' ? engine.pause() : engine.resume())}
        >
          {playLabel}
        </button>
        <button className="btn sq" title="Forward 10 s" disabled={seeking !== null} onClick={() => seek(s.time + 10)}>
          +10
        </button>
        <button className="btn" disabled={seeking !== null || !next} title={next ? `${KIND_LABEL[next.kind]}: ${next.label} at ${fmt(next.t)}` : 'No later incident'} onClick={() => next && seek(Math.max(0, next.t - 3))}>
          Next incident{next ? ` · ${fmt(next.t)}` : ''}
        </button>
        <span className="replay-time mono">
          {fmt(s.time)} / {fmt(duration)}
        </span>
        <span className="replay-stats">
          {incidents.length} incidents · {deliveries} deliveries
        </span>
        <span className="replay-spacer" />
        {verdict &&
          (verdict.match ? (
            <span className="chip ok" title="Every recorded event matches the re-simulated run">
              ✓ Verified: {verdict.lines} events identical
            </span>
          ) : (
            <span className="chip bad" title={`expected: ${verdict.expected}\nactual: ${verdict.actual}`}>
              ✗ Diverges at event {verdict.index + 1}
              {verdict.t !== null ? ` (t = ${verdict.t.toFixed(1)} s)` : ''}
            </span>
          ))}
        {error && <span className="chip bad">{error}</span>}
        <input
          ref={file}
          type="file"
          accept=".jsonl,.ndjson,.txt,application/x-ndjson"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />
        <button className="btn" disabled={seeking !== null} onClick={() => file.current?.click()} title="Load an events.jsonl recorded from this scenario and verify it">
          Load log
        </button>
        <button className="btn" onClick={save} title="Save this run's structured event log (JSONL)">
          Save log
        </button>
        <button className="btn sq" title="Close the replay bar" onClick={() => setReplay(false)}>
          ×
        </button>
      </div>
      <div
        className={`replay-track ${seeking !== null ? 'busy' : ''}`}
        ref={track}
        onClick={(e) => void seek(tAt(e.clientX))}
        onMouseMove={(e) => setHover({ x: e.clientX - track.current!.getBoundingClientRect().left, t: tAt(e.clientX) })}
        onMouseLeave={() => setHover(null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) void onFile(f);
        }}
      >
        <div className="replay-fill" style={{ width: pct(s.time) }} />
        {loaded && <div className="replay-recorded" style={{ width: pct(loaded.endT) }} title="Span of the loaded recording" />}
        {markers.map((m, i) => (
          <i key={i} className={`replay-mark ${m.kind}`} style={{ left: pct(m.t) }} title={`${fmt(m.t)} · ${KIND_LABEL[m.kind]}: ${m.label}`} />
        ))}
        <div className="replay-head" style={{ left: pct(s.time) }} />
        {hover && seeking === null && (
          <div className="replay-hover mono" style={{ left: hover.x }}>
            {fmt(hover.t)}
          </div>
        )}
        {seeking !== null && <div className="replay-seeking mono">re-simulating… {Math.round(seeking * 100)}%</div>}
      </div>
    </div>
  );
}
