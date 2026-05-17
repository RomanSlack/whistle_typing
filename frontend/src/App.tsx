import { useEffect, useMemo, useRef, useState } from "react";
import { PitchCanvas } from "./PitchCanvas";
import { WhistleDecoder, DecoderEvent } from "./decoder";
import { ZONE_LETTERS, matchWords, letterToZone } from "./wordlist";

const LS_LLM = "whistle.llm";
const LS_MIC = "whistle.mic_name";
import { Calibration } from "./Calibration";

interface Sample { t: number; freq: number | null; conf: number; }

const WS_URL = "ws://localhost:8000/ws/pitch";
const API_BASE = "http://localhost:8000";

interface MicDevice {
  index: number;
  name: string;
  channels: number;
  samplerate: number;
  is_system_default: boolean;
}
const ZONES = ZONE_LETTERS.length;

const LS_FMIN = "whistle.fmin";
const LS_FMAX = "whistle.fmax";

function loadStoredRange(): { fmin: number; fmax: number } | null {
  const lo = Number(localStorage.getItem(LS_FMIN));
  const hi = Number(localStorage.getItem(LS_FMAX));
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > lo) {
    return { fmin: lo, fmax: hi };
  }
  return null;
}

export function App() {
  const stored = loadStoredRange();
  const [connected, setConnected] = useState(false);
  const [fmin, setFmin] = useState(stored?.fmin ?? 600);
  const [fmax, setFmax] = useState(stored?.fmax ?? 2400);
  const [calibrating, setCalibrating] = useState(stored == null);

  const [activeZone, setActiveZone] = useState<number | null>(null);
  const [latestPitch, setLatestPitch] = useState<number | null>(null);
  const [pendingZones, setPendingZones] = useState<number[]>([]);
  const [text, setText] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [currentDevice, setCurrentDevice] = useState<number | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [llmMode, setLlmMode] = useState(localStorage.getItem(LS_LLM) === "1");
  const [llmAvailable, setLlmAvailable] = useState(false);
  const [llmThinking, setLlmThinking] = useState(false);
  const textRef = useRef("");
  const llmModeRef = useRef(llmMode);
  useEffect(() => { textRef.current = text; }, [text]);
  useEffect(() => { llmModeRef.current = llmMode; }, [llmMode]);
  const [learnText, setLearnText] = useState("hello");
  const [playing, setPlaying] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playStopRef = useRef<(() => void) | null>(null);

  const bufferRef = useRef<Sample[]>([]);
  const pendingRef = useRef<number[]>([]);
  const decoderRef = useRef<WhistleDecoder | null>(null);
  const fminRef = useRef(fmin);
  const fmaxRef = useRef(fmax);
  const calibratingRef = useRef(calibrating);
  useEffect(() => { fminRef.current = fmin; }, [fmin]);
  useEffect(() => { fmaxRef.current = fmax; }, [fmax]);
  useEffect(() => { calibratingRef.current = calibrating; }, [calibrating]);

  const suggestions = useMemo(() => matchWords(pendingZones, 5), [pendingZones]);
  const topSuggestion = suggestions[0] ?? null;

  useEffect(() => { pendingRef.current = pendingZones; }, [pendingZones]);

  // Initialize decoder once
  useEffect(() => {
    const localBestWord = (keys: number[]) => {
      for (let n = keys.length; n >= Math.max(1, keys.length - 2); n--) {
        const s = matchWords(keys.slice(0, n), 1)[0];
        if (s) return s;
      }
      return null;
    };

    const finalizeWord = async (commitSuggestion: boolean) => {
      const keys = pendingRef.current;
      if (keys.length === 0) return;

      // Clear pending immediately so the UI feels responsive while we wait.
      setPendingZones([]);
      pendingRef.current = [];
      decoderRef.current?.noteWordReset();

      let word: string | null = null;
      if (commitSuggestion && llmModeRef.current) {
        setLlmThinking(true);
        try {
          const res = await fetch(`${API_BASE}/api/llm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              zones: keys,
              zone_letters: ZONE_LETTERS,
              context: textRef.current.slice(-200),
              candidates: matchWords(keys, 15),
            }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.word) word = data.word;
          }
        } catch { /* swallow — fall through to local */ }
        finally { setLlmThinking(false); }
      }
      if (!word && commitSuggestion) word = localBestWord(keys);
      if (!word) word = zonesToFallback(keys);
      setText(prev => prev + word + " ");
    };

    const handle = (e: DecoderEvent) => {
      if (e.type === "key") {
        setPendingZones(prev => {
          const next = [...prev, e.zone];
          pendingRef.current = next;
          return next;
        });
        decoderRef.current?.noteWordActive();
        flashToast(`Z${e.zone + 1}`);
      } else if (e.type === "accept") {
        flashToast("ACCEPT");
        finalizeWord(true);
      } else if (e.type === "backspace") {
        flashToast("BACKSPACE");
        if (pendingRef.current.length > 0) {
          const next = pendingRef.current.slice(0, -1);
          pendingRef.current = next;
          setPendingZones(next);
          if (next.length === 0) decoderRef.current?.noteWordReset();
        } else {
          setText(prev => prev.replace(/\s*\S*\s*$/, ""));
        }
      } else if (e.type === "commit") {
        flashToast("SPACE");
        finalizeWord(true);
      }
    };

    decoderRef.current = new WhistleDecoder(handle, { fmin, fmax, zones: ZONES });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    decoderRef.current?.setOptions({ fmin, fmax });
  }, [fmin, fmax]);

  // Single persistent WS connection
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let retryT: number | null = null;

    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!stop) retryT = window.setTimeout(connect, 1000);
      };
      ws.onerror = () => { ws?.close(); };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as Sample;
          const buf = bufferRef.current;
          buf.push(msg);
          const cutoff = msg.t - 10;
          while (buf.length > 0 && buf[0].t < cutoff) buf.shift();
          setLatestPitch(msg.freq);
          if (msg.freq != null) {
            setActiveZone(freqToZone(msg.freq, fminRef.current, fmaxRef.current, ZONES));
          } else {
            setActiveZone(null);
          }
          // Don't drive decoder while calibrating
          if (!calibratingRef.current) decoderRef.current?.feed(msg);
        } catch {}
      };
    };
    connect();
    return () => {
      stop = true;
      if (retryT) clearTimeout(retryT);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setText("");
        setPendingZones([]);
        pendingRef.current = [];
        decoderRef.current?.noteWordReset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const flashToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 700);
  };

  const refreshDevices = async (rescan = false) => {
    setDevicesLoading(true);
    try {
      const url = rescan ? `${API_BASE}/api/devices/rescan` : `${API_BASE}/api/devices`;
      const res = await fetch(url, { method: rescan ? "POST" : "GET" });
      const data = await res.json();
      setDevices(data.devices ?? []);
      setCurrentDevice(data.current ?? null);
    } catch (e) {
      console.warn("device list fetch failed", e);
    } finally {
      setDevicesLoading(false);
    }
  };

  const selectDevice = async (idx: number | null, name?: string | null) => {
    try {
      const res = await fetch(`${API_BASE}/api/device`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: idx, name: name ?? null }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setCurrentDevice(data.current ?? null);
      // Persist by NAME so the next session re-finds the same mic even if
      // PortAudio re-orders indices.
      if (name) localStorage.setItem(LS_MIC, name);
      else if (idx === null) localStorage.removeItem(LS_MIC);
      flashToast("MIC SWAPPED");
    } catch (e) {
      console.warn("device select failed", e);
      flashToast("MIC ERROR");
    }
  };

  // On mount: fetch devices, then if we have a remembered mic name, ask the
  // backend to switch to it. This survives backend restarts / index shuffles.
  useEffect(() => {
    (async () => {
      await refreshDevices();
      const savedName = localStorage.getItem(LS_MIC);
      if (savedName) {
        try {
          await fetch(`${API_BASE}/api/device`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: savedName }),
          });
          await refreshDevices();
        } catch { /* silent — leave on system default */ }
      }
    })();
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/api/llm/status`)
      .then(r => r.json())
      .then(d => setLlmAvailable(!!d.enabled))
      .catch(() => setLlmAvailable(false));
  }, []);

  const toggleLlm = () => {
    if (!llmAvailable) {
      flashToast("NO API KEY");
      return;
    }
    const next = !llmMode;
    setLlmMode(next);
    localStorage.setItem(LS_LLM, next ? "1" : "0");
    flashToast(next ? "LLM ON" : "LLM OFF");
  };

  const zoneCenterHz = (zone: number) => {
    return Math.exp(
      Math.log(fmin) + ((zone + 0.5) / ZONES) * (Math.log(fmax) - Math.log(fmin))
    );
  };

  const playLearnText = async () => {
    if (playing) { playStopRef.current?.(); return; }
    const text = learnText.toLowerCase();
    if (!text.trim()) return;

    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") await ctx.resume();

    setPlaying(true);
    const noteSec = 0.32;
    const gapSec = 0.06;
    const wordGapSec = 0.32;

    const oscs: OscillatorNode[] = [];
    const timeouts: number[] = [];
    let t = ctx.currentTime + 0.05;
    const startedAt = performance.now();

    for (const c of text) {
      if (c === " ") { t += wordGapSec; continue; }
      const zone = letterToZone(c);
      if (zone == null) continue;
      const freq = zoneCenterHz(zone);

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = 0.22;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(g, t + 0.018);
      gain.gain.setValueAtTime(g, t + noteSec - 0.04);
      gain.gain.linearRampToValueAtTime(0, t + noteSec);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + noteSec + 0.01);
      oscs.push(osc);

      const delayMs = (t - ctx.currentTime) * 1000 + (performance.now() - startedAt);
      timeouts.push(window.setTimeout(() => setActiveZone(zone), Math.max(0, delayMs)));

      t += noteSec + gapSec;
    }

    const totalMs = (t - ctx.currentTime) * 1000 + (performance.now() - startedAt);
    const endT = window.setTimeout(() => {
      setPlaying(false);
      setActiveZone(null);
      playStopRef.current = null;
    }, totalMs + 80);
    timeouts.push(endT);

    playStopRef.current = () => {
      for (const o of oscs) { try { o.stop(); } catch {} }
      for (const id of timeouts) clearTimeout(id);
      setPlaying(false);
      setActiveZone(null);
      playStopRef.current = null;
    };
  };

  const finishCalibration = (lo: number, hi: number) => {
    // Apply small headroom margins so edge zones are reachable
    const pad = 0.05;
    const span = Math.log(hi) - Math.log(lo);
    const fminAdj = Math.round(Math.exp(Math.log(lo) - span * pad));
    const fmaxAdj = Math.round(Math.exp(Math.log(hi) + span * pad));
    setFmin(fminAdj);
    setFmax(fmaxAdj);
    localStorage.setItem(LS_FMIN, String(fminAdj));
    localStorage.setItem(LS_FMAX, String(fmaxAdj));
    setCalibrating(false);
  };

  return (
    <>
      <div className="app">
        <header className="bar">
          <div className="brand">
            whistle<span className="dot">●</span>type
            <span className="sub">v0.1</span>
          </div>
          <div className="controls">
            <div className="mic-picker">
              <span className="mic-label">mic</span>
              <select
                value={currentDevice ?? ""}
                onChange={e => {
                  const v = e.target.value;
                  if (v === "") {
                    selectDevice(null, null);
                  } else {
                    const idx = Number(v);
                    const dev = devices.find(d => d.index === idx);
                    selectDevice(idx, dev?.name ?? null);
                  }
                }}
              >
                <option value="">system default</option>
                {devices.map(d => (
                  <option key={d.index} value={d.index}>
                    {d.name}{d.is_system_default ? "  ★" : ""}
                  </option>
                ))}
              </select>
              <button
                className="mic-refresh"
                onClick={() => refreshDevices(true)}
                title="rescan devices"
                disabled={devicesLoading}
                type="button"
              >
                {devicesLoading ? "…" : "↻"}
              </button>
            </div>
            <div className="range-chip">
              range <strong>{fmin}</strong>–<strong>{fmax}</strong> Hz
            </div>
            <button
              className={"chip btn llm-toggle " + (llmMode ? "on" : "") + (!llmAvailable ? " disabled" : "")}
              onClick={toggleLlm}
              title={llmAvailable ? "use LLM to disambiguate word commits" : "set GROQ_API_KEY on backend to enable"}
              type="button"
            >
              <span className="llm-dot" />llm
              {llmThinking && <span className="llm-spin">…</span>}
            </button>
            <button
              className="chip btn"
              onClick={() => setCalibrating(true)}
              type="button"
            >
              recalibrate
            </button>
            <div className={"status " + (connected ? "" : "off")}>
              <span className="pulse" />{connected ? "live" : "offline"}
            </div>
          </div>
        </header>

        <section className="stage">
          <PitchCanvas
            fmin={fmin} fmax={fmax} zones={ZONES}
            activeZone={activeZone}
            bufferRef={bufferRef}
          />
          <div className="zones">
            {ZONE_LETTERS.map((_, i) => {
              const z = ZONES - 1 - i;             // top row = highest zone
              const letters = ZONE_LETTERS[z];     // letters must match z, not i
              const top = (i / ZONES) * 100;
              const height = (1 / ZONES) * 100;
              const edges = zoneEdgeHz(z, fmin, fmax, ZONES);
              return (
                <div
                  key={z}
                  className={"zone " + (activeZone === z ? "active" : "")}
                  style={{ top: `${top}%`, height: `${height}%` }}
                >
                  <span className="letters">{letters.toUpperCase()}</span>
                  <span className="hz">{edges[0]}–{edges[1]} Hz</span>
                </div>
              );
            })}
          </div>
          <div className={"gesture-toast " + (toast ? "show" : "")}>{toast}</div>
        </section>

        <section className="suggestions">
          {suggestions.length === 0 && (
            <span className="hint">
              whistle &amp; hold a pitch to type · up-glide accepts · down-glide deletes
            </span>
          )}
          {suggestions.map((w, i) => (
            <div key={w} className={"suggestion " + (i === 0 ? "primary" : "")}>
              {w}
            </div>
          ))}
        </section>

        <section className="output">
          {text}
          {pendingZones.length > 0 && (
            <span className="pending-keys">
              {topSuggestion
                ? topSuggestion.slice(0, pendingZones.length)
                : zonesToFallback(pendingZones)}
            </span>
          )}
          <span className="cursor" />
        </section>

        <section className="learn">
          <div className="learn-label">learn</div>
          <input
            className="learn-input"
            value={learnText}
            onChange={e => setLearnText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); playLearnText(); } }}
            placeholder="type a word to hear it whistled…"
            spellCheck={false}
          />
          <button
            className={"btn " + (playing ? "" : "primary")}
            onClick={playLearnText}
            type="button"
          >
            {playing ? "stop" : "play ▶"}
          </button>
          <div className="learn-pips">
            {learnText.toLowerCase().split("").map((c, i) => {
              if (c === " ") return <span key={i} className="pip-gap" />;
              const z = letterToZone(c);
              if (z == null) return null;
              return (
                <span key={i} className="pip-letter" title={`zone ${z + 1} (${ZONE_LETTERS[z].toUpperCase()})`}>
                  <span className="pip-bar" style={{ height: `${((z + 1) / ZONES) * 100}%` }} />
                  <span className="pip-c">{c}</span>
                </span>
              );
            })}
          </div>
        </section>

        <footer className="legend">
          <span><kbd>hold</kbd>pitch ≥250ms → key</span>
          <span><kbd>↗</kbd>up-glide → accept</span>
          <span><kbd>↘</kbd>down-glide → backspace</span>
          <span><kbd>—</kbd>silence ≥800ms → space</span>
        </footer>
      </div>

      {calibrating && (
        <Calibration
          latestPitch={latestPitch}
          onComplete={finishCalibration}
          onSkip={() => setCalibrating(false)}
        />
      )}
    </>
  );
}

function freqToZone(freq: number, fmin: number, fmax: number, zones: number) {
  if (freq <= fmin) return 0;
  if (freq >= fmax) return zones - 1;
  const r = (Math.log(freq) - Math.log(fmin)) / (Math.log(fmax) - Math.log(fmin));
  return Math.max(0, Math.min(zones - 1, Math.floor(r * zones)));
}

function zoneEdgeHz(zone: number, fmin: number, fmax: number, zones: number): [number, number] {
  const lo = Math.exp(Math.log(fmin) + (zone / zones) * (Math.log(fmax) - Math.log(fmin)));
  const hi = Math.exp(Math.log(fmin) + ((zone + 1) / zones) * (Math.log(fmax) - Math.log(fmin)));
  return [Math.round(lo), Math.round(hi)];
}

function zonesToFallback(zones: number[]): string {
  return zones.map(z => ZONE_LETTERS[z][0]).join("");
}
