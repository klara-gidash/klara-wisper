"""The fake call app for W2: holds the default microphone (WASAPI/MME through PortAudio) for N seconds,
discarding the audio. Started as a copy of python.exe named zoom.exe, so Windows records "zoom.exe is
using the microphone" (ConsentStore) and Klara Wisper's helper sees a Zoom call.
Usage: zoom.exe hold_mic.py [seconds]"""
import sys
import time

import sounddevice as sd

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 1200
dev = sd.query_devices(kind="input")
print(f"holding input {dev['name']!r} for {seconds:.0f} s", flush=True)
with sd.InputStream(channels=1, samplerate=int(dev["default_samplerate"]), callback=lambda *a: None):
    time.sleep(seconds)
print("released", flush=True)
