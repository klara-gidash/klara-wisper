"""The fake call app for W2: holds the microphone for N seconds, discarding the audio. Started as a
copy of python.exe named zoom.exe, so Windows can record "zoom.exe is using the microphone"
(ConsentStore) and Klara Wisper's helper sees a Zoom call.
Tries WASAPI, then the default host API. If no capture opens (Windows Server runners refuse some),
it still stays running, so the test's hand-written ConsentStore entry belongs to a live zoom.exe.
Usage: zoom.exe hold_mic.py [seconds]"""
import sys
import time

import sounddevice as sd

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 1200


def try_open():
    apis = sd.query_hostapis()
    order = [i for i, a in enumerate(apis) if "WASAPI" in a["name"]] + [None]
    for api in order:
        dev = apis[api]["default_input_device"] if api is not None else sd.default.device[0]
        if dev is None or dev < 0:
            continue
        info = sd.query_devices(dev)
        try:
            s = sd.InputStream(device=dev, channels=1, samplerate=int(info["default_samplerate"]), callback=lambda *a: None)
            s.start()
            print(f"holding {info['name']!r} via {sd.query_hostapis(info['hostapi'])['name']}", flush=True)
            return s
        except Exception as e:  # noqa: BLE001
            print(f"could not open {info['name']!r}: {e}", flush=True)
    print("no capture opened; staying alive without one", flush=True)
    return None


stream = try_open()
time.sleep(seconds)
if stream:
    stream.close()
print("released", flush=True)
