"""FastAPI server that streams real-time whistle pitch over WebSocket.

Run:  uvicorn main:app --reload --port 8000
"""
import asyncio
import json
import os
import queue
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
import numpy as np
import sounddevice as sd
from dotenv import load_dotenv
load_dotenv()  # pulls backend/.env into os.environ at startup
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pitch import detect_pitch

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")

SAMPLE_RATE = 44100
BLOCK = 2048
CHANNELS = 1

audio_q: queue.Queue[np.ndarray] = queue.Queue(maxsize=32)

# Mutable stream state — guarded by a lock so HTTP swaps don't race the
# audio callback. We track the chosen device by NAME (stable across PortAudio
# re-inits) and only resolve to an index at open time.
_stream: Optional[sd.InputStream] = None
_current_device: Optional[int] = None
_current_device_name: Optional[str] = None
_stream_lock = asyncio.Lock()


def _resolve_device(target: Optional[int | str]) -> Optional[int]:
    """Resolve a device by index or name to a currently-valid index, or None."""
    if target is None:
        return None
    devs = sd.query_devices()
    if isinstance(target, int):
        if 0 <= target < len(devs) and devs[target].get("max_input_channels", 0) > 0:
            return target
        return None
    # by name (substring match, case-insensitive)
    needle = target.lower()
    for i, d in enumerate(devs):
        if d.get("max_input_channels", 0) > 0 and needle in d["name"].lower():
            return i
    return None


def _audio_cb(indata, frames, time_info, status):
    try:
        audio_q.put_nowait(indata[:, 0].copy())
    except queue.Full:
        pass


def _open_stream(device: Optional[int]):
    """Open a new InputStream on `device` (None = system default).

    Retries a few times with backoff because raw ALSA hw: devices can stay
    locked for ~1-2s after the previous owner releases them — most often when
    the backend restarts and the kernel hasn't freed the USB endpoint yet.
    """
    global _stream, _current_device, _current_device_name
    if _stream is not None:
        try:
            _stream.stop()
            _stream.close()
        except Exception:
            pass
        _stream = None

    last_err: Optional[Exception] = None
    for delay in (0.0, 0.3, 0.6, 1.2, 2.0):
        if delay:
            time.sleep(delay)
        try:
            s = sd.InputStream(
                samplerate=SAMPLE_RATE,
                blocksize=BLOCK,
                channels=CHANNELS,
                dtype="float32",
                callback=_audio_cb,
                device=device,
            )
            s.start()
            _stream = s
            _current_device = device
            info = (sd.query_devices(device, "input") if device is not None
                    else sd.query_devices(kind="input"))
            _current_device_name = info["name"]
            print(f"[mic] streaming from device={device} '{info['name']}' @ {SAMPLE_RATE}Hz"
                  + (f" (after {delay:.1f}s wait)" if delay else ""))
            return
        except Exception as e:
            last_err = e
            print(f"[mic] open failed (delay={delay:.1f}s): {e}")
    raise last_err if last_err else RuntimeError("could not open audio device")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _open_stream(None)  # system default
    try:
        yield
    finally:
        if _stream is not None:
            _stream.stop()
            _stream.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"status": "ok", "ws": "/ws/pitch"}


@app.get("/api/devices")
def list_devices():
    """Return all input-capable devices plus the currently selected one."""
    devs = sd.query_devices()
    out = []
    default_in = sd.default.device[0] if sd.default.device else None
    for i, d in enumerate(devs):
        if d.get("max_input_channels", 0) <= 0:
            continue
        out.append({
            "index": i,
            "name": d["name"],
            "channels": d["max_input_channels"],
            "samplerate": int(d["default_samplerate"]),
            "is_system_default": (i == default_in),
        })
    return {
        "devices": out,
        "current": _current_device,
        "current_name": _current_device_name,
        "system_default": default_in,
    }


@app.post("/api/devices/rescan")
async def rescan_devices():
    """Tear down the stream, re-init PortAudio (so hot-plugged devices appear),
    then re-open the stream by NAME (so an index shift can't lose the user's
    chosen device)."""
    global _stream
    async with _stream_lock:
        prev_name = _current_device_name

        def _do():
            global _stream
            if _stream is not None:
                try:
                    _stream.stop(); _stream.close()
                except Exception:
                    pass
                _stream = None
            sd._terminate()
            sd._initialize()
            new_idx = _resolve_device(prev_name) if prev_name else None
            try:
                _open_stream(new_idx)
            except Exception:
                _open_stream(None)

        await asyncio.get_running_loop().run_in_executor(None, _do)
    return list_devices()


class DeviceReq(BaseModel):
    index: Optional[int] = None   # may be a stale index — we re-resolve
    name: Optional[str] = None    # preferred: stable identifier


@app.post("/api/device")
async def set_device(req: DeviceReq):
    async with _stream_lock:
        # Prefer name (stable) over index (volatile).
        target: Optional[int | str] = req.name if req.name else req.index
        resolved = _resolve_device(target) if target is not None else None
        if target is not None and resolved is None:
            raise HTTPException(status_code=404, detail=f"device not found: {target!r}")
        try:
            await asyncio.get_running_loop().run_in_executor(
                None, _open_stream, resolved,
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"failed to open device: {e}")
        # Drop any stale audio buffered from the previous device
        try:
            while True:
                audio_q.get_nowait()
        except queue.Empty:
            pass
    return {"ok": True, "current": _current_device, "current_name": _current_device_name}


class LLMReq(BaseModel):
    zones: list[int]              # sequence of zone presses, e.g. [3, 3, 5, 5, 4]
    zone_letters: list[str]       # ["qxz", "jkv", "bpw", "aeh", ...]
    context: str = ""             # previously typed text, for continuation
    candidates: list[str] = []    # frontend's wordlist candidates that fit the zones


@app.get("/api/llm/status")
def llm_status():
    return {"enabled": bool(GROQ_API_KEY), "model": GROQ_MODEL if GROQ_API_KEY else None}


@app.post("/api/llm")
async def llm_decode(req: LLMReq):
    if not GROQ_API_KEY:
        raise HTTPException(503, "GROQ_API_KEY not set on backend")
    if not req.zones:
        return {"word": ""}

    n = len(req.zones)
    template = "".join(f"[{req.zone_letters[z].upper()}]" for z in req.zones)
    cands = [c for c in req.candidates if c and c.isalpha()][:25]
    cand_block = ", ".join(cands) if cands else "(none from local wordlist)"

    system = (
        "You disambiguate whistled words. The user whistled a sequence of pitch zones; "
        "each zone contains 3-4 letters. The frontend has already enumerated all matching "
        "words from a local wordlist. Pick the one that best continues the prior text. "
        "If NONE of the candidates fit the context naturally, you may propose your own "
        "English word — but it MUST be EXACTLY the right length and every letter must "
        "come from its zone's allowed set. Respond with ONLY one lowercase word, no "
        "punctuation, no commentary, no quotes."
    )
    user = (
        f"Whistled word has {n} letters. Pattern (each [...] = letters allowed in that slot):\n"
        f"  {template}\n\n"
        f"Local wordlist candidates that fit the pattern: {cand_block}\n\n"
        f"Prior typed text: \"{req.context[-200:]}\"\n\n"
        f"Best word:"
    )

    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                json={
                    "model": GROQ_MODEL,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "max_tokens": 12,
                    "temperature": 0.1,
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        raise HTTPException(502, f"llm call failed: {e}")

    # Strip everything that isn't a letter; pick the first alphabetic token.
    m = re.search(r"[a-zA-Z]+", content or "")
    word = m.group(0).lower() if m else ""

    # Sanity-check: must be exact length AND each letter in its zone's set.
    valid = bool(word) and len(word) == len(req.zones)
    if valid:
        for i, ch in enumerate(word):
            if ch not in req.zone_letters[req.zones[i]]:
                valid = False
                break
    if not valid:
        # Fall back to the top frontend candidate if any (lets the wordlist
        # serve as a safety net even when the LLM hallucinates).
        word = req.candidates[0] if req.candidates else ""

    return {"word": word}


@app.websocket("/ws/pitch")
async def ws_pitch(ws: WebSocket):
    await ws.accept()
    print("[ws] client connected")
    loop = asyncio.get_running_loop()
    try:
        while True:
            block = await loop.run_in_executor(None, audio_q.get)
            freq, conf = detect_pitch(block, SAMPLE_RATE)
            await ws.send_text(json.dumps({"t": time.time(), "freq": freq, "conf": conf}))
    except WebSocketDisconnect:
        print("[ws] client disconnected")
    except Exception as e:
        print(f"[ws] error: {e}")
