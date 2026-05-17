"""Real-time pitch detection via FFT autocorrelation.

Optimized for whistling (strong fundamental, ~500Hz-4kHz).
"""
import numpy as np


def detect_pitch(samples: np.ndarray, sr: int,
                 fmin: float = 500.0, fmax: float = 4000.0,
                 confidence_threshold: float = 0.35) -> tuple[float | None, float]:
    """Return (frequency_hz, confidence) or (None, confidence) if no clear pitch."""
    if samples.size == 0:
        return None, 0.0

    # DC removal + silence gate
    samples = samples - np.mean(samples)
    rms = float(np.sqrt(np.mean(samples ** 2)))
    if rms < 0.005:
        return None, 0.0

    # Normalize so confidence is comparable across volumes
    samples = samples / (np.max(np.abs(samples)) + 1e-9)

    n = samples.size
    # FFT-based autocorrelation (zero-padded to avoid circular wrap)
    fft = np.fft.rfft(samples, n=2 * n)
    acorr = np.fft.irfft(fft * np.conj(fft))[:n].real
    if acorr[0] <= 0:
        return None, 0.0
    acorr = acorr / acorr[0]

    tau_min = max(2, int(sr / fmax))
    tau_max = min(n - 2, int(sr / fmin))
    if tau_max <= tau_min:
        return None, 0.0

    region = acorr[tau_min:tau_max]
    rel_idx = int(np.argmax(region))
    peak = rel_idx + tau_min
    confidence = float(acorr[peak])
    if confidence < confidence_threshold:
        return None, confidence

    # Parabolic interpolation for sub-sample precision
    a, b, c = acorr[peak - 1], acorr[peak], acorr[peak + 1]
    denom = (a - 2 * b + c)
    offset = 0.5 * (a - c) / denom if denom != 0 else 0.0
    refined = peak + offset
    freq = sr / refined if refined > 0 else None
    if freq is None or freq < fmin or freq > fmax:
        return None, confidence
    return float(freq), confidence
