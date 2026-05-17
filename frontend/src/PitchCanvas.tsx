import { useEffect, useRef } from "react";

interface Sample { t: number; freq: number | null; }

interface Props {
  fmin: number;
  fmax: number;
  zones: number;
  activeZone: number | null;
  // Ref-shared mutable buffer from parent; we render whatever is in there.
  bufferRef: React.MutableRefObject<Sample[]>;
  windowSeconds?: number;
}

export function PitchCanvas({
  fmin, fmax, zones, activeZone, bufferRef, windowSeconds = 5,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth: w, clientHeight: h } = canvas;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const freqToY = (freq: number, h: number) => {
      // log-scaled, low at bottom, high at top
      const ratio = (Math.log(freq) - Math.log(fmin)) / (Math.log(fmax) - Math.log(fmin));
      const clamped = Math.max(0, Math.min(1, ratio));
      return h - clamped * h;
    };

    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // Zone band tints (subtle alternation)
      for (let z = 0; z < zones; z++) {
        const yTop = h - ((z + 1) / zones) * h;
        const yBot = h - (z / zones) * h;
        if (z === activeZone) {
          ctx.fillStyle = "rgba(16,185,129,0.10)";
          ctx.fillRect(0, yTop, w, yBot - yTop);
        }
      }

      // Pitch trail
      const buf = bufferRef.current;
      if (buf.length > 0) {
        const nowT = buf[buf.length - 1].t;
        const start = nowT - windowSeconds;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#10b981";
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        let started = false;
        ctx.beginPath();
        for (const s of buf) {
          if (s.t < start) continue;
          const x = ((s.t - start) / windowSeconds) * w;
          if (s.freq == null) {
            started = false;
            continue;
          }
          const y = freqToY(s.freq, h);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Leading dot
        for (let i = buf.length - 1; i >= 0; i--) {
          const s = buf[i];
          if (s.freq != null && s.t >= start) {
            const x = ((s.t - start) / windowSeconds) * w;
            const y = freqToY(s.freq, h);
            ctx.fillStyle = "#047857";
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fmin, fmax, zones, activeZone, bufferRef, windowSeconds]);

  return <canvas ref={canvasRef} />;
}
