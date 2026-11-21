"""Plays a 16-bit PCM .wav into an output device (by name substring, or "default").
Used by the e2e call test to speak "my side" into VB-Cable's "CABLE Input" and "the other side"
into the default playback device.

    python play.py <file.wav> <device substring|default> [--list]
Needs: sounddevice, numpy (pinned in the workflow).
"""
import sys
import wave

import numpy as np
import sounddevice as sd


def main() -> None:
    if "--list" in sys.argv:
        print(sd.query_devices())
        return
    path, want = sys.argv[1], sys.argv[2]
    with wave.open(path, "rb") as w:
        rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        if width != 2:
            sys.exit(f"FAIL: {path} is not 16-bit PCM")
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, ch)
    device = None
    if want != "default":
        # Prefer the MME/WASAPI entry whose name contains the substring and has outputs.
        for i, d in enumerate(sd.query_devices()):
            if want.lower() in d["name"].lower() and d["max_output_channels"] > 0:
                device = i
                break
        if device is None:
            print(sd.query_devices())
            sys.exit(f"FAIL: no output device matching '{want}'")
    name = sd.query_devices(device if device is not None else sd.default.device[1])["name"]
    sd.play(data, rate, device=device, blocking=True)
    print(f"ok: played {path} ({len(data) / rate:.1f} s) into {name}")


if __name__ == "__main__":
    main()
