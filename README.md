# whistle.type

Type by whistling. Real-time pitch detection → 8 vowel-centered pitch zones → autocompleted words, optionally disambiguated by an LLM.

```
┌─ mic ──┐   websocket   ┌─ react ──────────────────────┐
│ python │ ─────────────▶│ canvas viz · decoder · words │
│ FastAPI│  {freq,conf}  │  optional → Groq LLM rank    │
└────────┘               └──────────────────────────────┘
```

## Mapping

Eight log-spaced pitch zones, low → high:

```
z0  Q X Z      rare
z1  J K V
z2  B P W
z3  A E H      ← vowels
z4  I O U      ← vowels
z5  L M N
z6  D F G Y
z7  C R S T    common
```

Hold any zone ≥ 150 ms to commit a "key". Silence ≥ 1.5 s finalizes the word with the top autocomplete match. Full-range upward sweep = accept gesture; full-range downward sweep = backspace. Press **Esc** any time to wipe the output.

## Features

- **Calibration overlay** — auto-captures your lowest and highest comfortable pitches when you hold each one steady (±7% over ~1.2 s). Range persists to localStorage.
- **Mic picker** in the top bar — dropdown of all input devices with a ↻ rescan button that picks up hot-plugged devices. Selection is persisted by *name* (not index) so it survives backend restarts and PortAudio index reshuffles. Auto-retries with backoff if the kernel hasn't released the ALSA endpoint yet.
- **Live pitch visualization** — scrolling trail on a log-frequency axis with the active zone highlighted.
- **Smoothed-hold decoder** — median-smooths pitch over ~3 samples to kill one-frame wobbles, then requires the smoothed zone to stay constant for 150 ms before emitting. Re-entering the same zone after silence/move re-arms the streak so double letters work.
- **Learn / playback** — type any phrase into the bottom box; **Play** synthesizes a sine-wave whistle of that word at the exact zone-center frequencies, with live zone-highlight as it plays. Hear what each word should sound like.
- **Autocomplete suggestions** — bundled ~700 common words filtered against the current zone sequence.
- **LLM mode (optional)** — when enabled, on each word commit the frontend sends the top wordlist candidates + your prior typed text to Groq (`llama-3.3-70b-versatile` by default), which ranks them in context. ~250-400 ms round-trip. Backend sanity-checks the response against the zone constraints and falls back to the local matcher if anything fails.

## Run

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# (Linux: sudo apt install libportaudio2)

# Optional — enable LLM mode
echo "GROQ_API_KEY=gsk_..." > .env
echo "GROQ_MODEL=llama-3.3-70b-versatile" >> .env

uvicorn main:app --port 8000
```

```bash
# Frontend (separate terminal)
cd frontend
npm install
npm run dev          # → http://localhost:5173
```

First load drops into calibration. After that your range, mic selection, and LLM-mode toggle are remembered.

## Layout

```
backend/
  main.py          FastAPI + sounddevice + Groq route
  pitch.py         FFT-autocorrelation pitch detector (numpy-only)
  .env             GROQ_API_KEY (gitignored)
frontend/src/
  App.tsx          orchestrator, WS, mic picker, LLM toggle
  PitchCanvas.tsx  scrolling pitch trail
  decoder.ts       smoothed-hold zone decoder + gestures
  wordlist.ts      ~700 words + zone-match function
  Calibration.tsx  auto-capture range overlay
  styles.css       pure-white + soft-shadow + emerald accents
```

## Tuning

Decoder constants live in `DEFAULT_OPTIONS` in `decoder.ts` (`holdMs`, `silenceMs`, `gestureSpan`, …). Drop a bigger corpus into `wordlist.ts` for richer offline matching. Swap models via `GROQ_MODEL` env var.
