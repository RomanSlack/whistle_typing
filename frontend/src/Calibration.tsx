import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  latestPitch: number | null;
  onComplete: (fmin: number, fmax: number) => void;
  onSkip: () => void;
}

type Step = "intro" | "low" | "high" | "done";

const STABILITY_SAMPLES = 26; // ~1.2s @ ~22Hz
const STABILITY_TOL = 0.07;   // ±7% around running median = "steady"

export function Calibration({ latestPitch, onComplete, onSkip }: Props) {
  const [step, setStep] = useState<Step>("intro");
  const [low, setLow] = useState<number | null>(null);
  const [high, setHigh] = useState<number | null>(null);
  const [progress, setProgress] = useState(0); // 0..1
  const [livePitch, setLivePitch] = useState<number | null>(null);

  const history = useRef<number[]>([]);

  // Reset capture state when entering a capture step
  useEffect(() => {
    history.current = [];
    setProgress(0);
  }, [step]);

  // Smoothly track latest pitch and run stability detector
  useEffect(() => {
    setLivePitch(latestPitch);
    if (step !== "low" && step !== "high") return;

    if (latestPitch == null) {
      history.current = [];
      setProgress(0);
      return;
    }

    history.current.push(latestPitch);
    if (history.current.length > STABILITY_SAMPLES) history.current.shift();

    const recent = history.current;
    const sorted = [...recent].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const stable = recent.every(f => Math.abs(f - median) / median < STABILITY_TOL);

    if (stable) {
      const p = Math.min(1, recent.length / STABILITY_SAMPLES);
      setProgress(p);
      if (recent.length >= STABILITY_SAMPLES) {
        // Captured!
        if (step === "low") {
          setLow(Math.round(median));
          setStep("high");
        } else {
          setHigh(Math.round(median));
          setStep("done");
        }
      }
    } else {
      setProgress(0);
    }
  }, [latestPitch, step]);

  const ringStyle = useMemo<React.CSSProperties>(
    () => ({ ["--p" as any]: progress * 100 }),
    [progress],
  );

  const pip = (s: Step) => {
    const order: Step[] = ["intro", "low", "high", "done"];
    const cur = order.indexOf(step);
    const idx = order.indexOf(s);
    if (idx < cur) return "done";
    if (idx === cur) return "active";
    return "";
  };

  return (
    <div className="cal-overlay">
      <div className="cal-card">
        <div className="cal-steps">
          <div className={"pip " + pip("low")} />
          <div className={"pip " + pip("high")} />
          <div className={"pip " + pip("done")} />
        </div>

        {step === "intro" && (
          <>
            <h2 className="cal-title">Calibrate your whistle</h2>
            <p className="cal-sub">
              We'll learn the lowest and highest pitches you can comfortably whistle —
              just hold each note steady for about a second. Auto-captures when stable.
            </p>
            <div className="cal-actions">
              <button className="btn primary" onClick={() => setStep("low")}>
                Begin
              </button>
              <button className="btn ghost" onClick={onSkip}>
                Skip
              </button>
            </div>
          </>
        )}

        {(step === "low" || step === "high") && (
          <>
            <h2 className="cal-title">
              {step === "low" ? "Whistle your lowest pitch" : "Whistle your highest pitch"}
            </h2>
            <p className="cal-sub">
              Hold a comfortable, steady tone. We'll auto-capture when it's stable.
            </p>

            <div className="cal-dial">
              <div className="ring" style={ringStyle} />
              <div className="pitch-readout">
                <div className={"hz-big " + (livePitch == null ? "silent" : "")}>
                  {livePitch != null ? Math.round(livePitch) : "—"}
                </div>
                <span className="hz-unit">Hz</span>
              </div>
            </div>

            <div className="cal-meter">
              <div className="fill" style={{ width: `${progress * 100}%` }} />
            </div>

            <div className="cal-row">
              <div>
                low
                <span className={"val " + (low == null ? "dim" : "")}>
                  {low != null ? `${low}Hz` : "—"}
                </span>
              </div>
              <div>
                high
                <span className={"val " + (high == null ? "dim" : "")}>
                  {high != null ? `${high}Hz` : "—"}
                </span>
              </div>
            </div>

            <div className="cal-actions">
              <button className="btn ghost" onClick={onSkip}>Skip</button>
            </div>
          </>
        )}

        {step === "done" && low != null && high != null && (
          <>
            <h2 className="cal-title">Calibrated</h2>
            <p className="cal-sub">
              Your whistle range covers about {Math.round(Math.log2(high / low) * 12)} semitones.
              You can re-run this any time from the top bar.
            </p>

            <div className="cal-row" style={{ marginTop: 18 }}>
              <div>
                fmin
                <span className="val">{low}Hz</span>
              </div>
              <div>
                fmax
                <span className="val">{high}Hz</span>
              </div>
            </div>

            <div className="cal-actions">
              <button
                className="btn primary"
                onClick={() => onComplete(low, high)}
              >
                Use these
              </button>
              <button className="btn ghost" onClick={() => setStep("low")}>
                Redo
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
