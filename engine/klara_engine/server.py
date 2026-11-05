"""WebSocket server the Electron app talks to (127.0.0.1, random port, token in the URL).

The app writes the connection token as the first line on stdin (not in the environment, where
other processes of the same user could read it). Prints {"event": "listening", "port": N} when
ready, and exits when stdin closes (the app quit or crashed). Requests carrying an Origin header
(i.e. from a web page) are refused.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from websockets.asyncio.server import ServerConnection, serve
from websockets.http11 import Request

from .engine import Engine
from .paths import data_dir


def _data_dir() -> Path:
    path = data_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


async def main() -> None:
    token = sys.stdin.readline().strip()
    if len(token) < 32:
        sys.exit("klara-engine: missing connection token on stdin")
    port = int(os.environ.get("KLARA_ENGINE_PORT", "0"))
    loop = asyncio.get_running_loop()
    outboxes: set[asyncio.Queue[str]] = set()

    def emit(msg: dict) -> None:  # called from any thread
        data = json.dumps(msg, ensure_ascii=False)
        for q in list(outboxes):
            loop.call_soon_threadsafe(q.put_nowait, data)

    engine = Engine(emit, _data_dir())

    def check_token(connection: ServerConnection, request: Request):
        given = parse_qs(urlparse(request.path).query).get("token", [""])[0]
        if request.headers.get("Origin") or not hmac.compare_digest(given.encode(), token.encode()):
            return connection.respond(403, "forbidden\n")
        return None

    async def handler(ws: ServerConnection) -> None:
        outbox: asyncio.Queue[str] = asyncio.Queue()
        outboxes.add(outbox)

        async def sender() -> None:
            while True:
                await ws.send(await outbox.get())

        task = asyncio.create_task(sender())
        await outbox.put(json.dumps(engine.status(), ensure_ascii=False))
        try:
            async for raw in ws:
                try:
                    engine.handle(json.loads(raw))
                except Exception as exc:
                    emit({"type": "error", "message": f"bad message: {exc}"})
        finally:
            outboxes.discard(outbox)
            task.cancel()

    def watch_parent() -> None:
        sys.stdin.read()
        os._exit(0)

    threading.Thread(target=watch_parent, daemon=True).start()

    # No keepalive pings: this is a local pipe, and pings time out whenever the Mac sleeps.
    async with serve(handler, "127.0.0.1", port, process_request=check_token, max_size=2**24, ping_interval=None) as server:
        actual = server.sockets[0].getsockname()[1] if hasattr(server, "sockets") else port
        print(json.dumps({"event": "listening", "port": actual}), flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    os.umask(0o077)  # transcripts, voiceprints and logs are private to the user
    import torch

    torch.set_num_threads(4)  # VAD, voiceprints and the after-call speaker step (CPU)
    asyncio.run(main())
