"""The fake call app for W2: holds a microphone for N seconds, discarding the audio. Started as a copy
of python.exe named zoom.exe, so Windows records "zoom.exe is using the microphone" (ConsentStore) and
Klara Wisper's helper sees a Zoom call.
Tries the VB-Cable recording device through WASAPI first (what the app itself uses; MME fails there on
Windows Server with "MME error 1"), then every other input / host API until one opens.
Usage: zoom.exe hold_mic.py [seconds]"""
import sys
import time

import sounddevice as sd

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 1200
apis = sd.query_hostapis()
order = {"Windows WASAPI": 0, "Windows WDM-KS": 1, "Windows DirectSound": 2, "MME": 3}
candidates = []
for i, d in enumerate(sd.query_devices()):
    if d["max_input_channels"] < 1:
        continue
    api = apis[d["hostapi"]]["name"]
    candidates.append((0 if "CABLE Output" in d["name"] else 1, order.get(api, 9), i, d, api))
candidates.sort(key=lambda c: c[:3])

for _, _, i, d, api in candidates:
    try:
        stream = sd.InputStream(device=i, channels=1, samplerate=int(d["default_samplerate"]), callback=lambda *a: None)
        stream.start()
    except Exception as e:  # noqa: BLE001 - try the next one
        print(f"could not open {d['name']!r} ({api}): {e}", flush=True)
        continue
    print(f"holding {d['name']!r} ({api}) for {seconds:.0f} s", flush=True)
    time.sleep(seconds)
    stream.stop()
    stream.close()
    print("released", flush=True)
    sys.exit(0)
print("no input device could be opened", file=sys.stderr, flush=True)
sys.exit(1)
