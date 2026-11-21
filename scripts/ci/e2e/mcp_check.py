"""Acts like Claude Desktop: reads claude_desktop_config.json, starts the "klara-wisper" MCP server
exactly as listed there (command + args, the inherited environment plus the entry's env, if any),
and checks its tools over stdio JSON-RPC.

Stdlib only on purpose: it talks the wire protocol (newline-delimited JSON-RPC 2.0, the MCP stdio
transport) the same way Claude Desktop does, so it doesn't depend on any client SDK's API.

    python mcp_check.py --config <claude_desktop_config.json>
        [--upcoming "בדיקת שיחה"]   list_upcoming_meetings must mention this text
        [--live]                     get_transcript('live') must return Hebrew
        [--meeting "בדיקת שיחה"]    list_meetings must mention this text (else: just has to work)
        [--keep-running SECONDS]     keep the server process open afterwards (the upgrade test)
Exit code 0 = every check passed. Prints "ok: ..." / "FAIL: ..." per check.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time

HEBREW = re.compile(r"[֐-׿]")
REQUIRED_TOOLS = ["list_meetings", "get_transcript", "list_upcoming_meetings", "search_transcripts"]
failures: list[str] = []


def ok(msg: str) -> None:
    print(f"ok: {msg}", flush=True)


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", flush=True)
    failures.append(msg)


class Server:
    def __init__(self, command: str, args: list[str], env: dict):
        self.proc = subprocess.Popen(
            [command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env
        )
        self.lines: "queue.Queue[bytes]" = queue.Queue()
        self.stderr: list[str] = []
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._pump_err, daemon=True).start()
        self.next_id = 1

    def _pump(self) -> None:
        for line in self.proc.stdout:
            self.lines.put(line)

    def _pump_err(self) -> None:
        for line in self.proc.stderr:
            self.stderr.append(line.decode("utf-8", "replace").rstrip())

    def send(self, msg: dict) -> None:
        self.proc.stdin.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def request(self, method: str, params: dict | None = None, timeout: float = 120) -> dict:
        rid = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                raw = self.lines.get(timeout=max(0.1, deadline - time.time()))
            except queue.Empty:
                break
            try:
                msg = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue  # not ours (a stray print would break Claude too, but report it via the result)
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
        raise TimeoutError(f"{method}: no answer in {timeout:.0f} s (server exit code {self.proc.poll()})")

    def call(self, tool: str, arguments: dict) -> str:
        res = self.request("tools/call", {"name": tool, "arguments": arguments})
        text = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        if res.get("isError"):
            raise RuntimeError(f"{tool} returned an error: {text[:300]}")
        return text

    def close(self) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(10)
        except Exception:
            self.proc.kill()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--upcoming")
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--meeting")
    ap.add_argument("--keep-running", type=int, default=0)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    try:
        with open(a.config, encoding="utf-8-sig") as f:
            entry = json.load(f)["mcpServers"]["klara-wisper"]
        ok(f"{a.config} lists klara-wisper: {entry['command']} {' '.join(entry.get('args', []))}")
    except Exception as e:
        fail(f"no klara-wisper entry in {a.config}: {e}")
        return 1
    if not os.path.exists(entry["command"]):
        fail(f"the configured command does not exist: {entry['command']}")
        return 1

    env = {**os.environ, **(entry.get("env") or {})}
    srv = Server(entry["command"], entry.get("args", []), env)
    try:
        init = srv.request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "klara-wisper-e2e", "version": "1"},
        })
        ok(f"initialize: {init.get('serverInfo', {})}")
        srv.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

        names = [t["name"] for t in srv.request("tools/list").get("tools", [])]
        missing = [t for t in REQUIRED_TOOLS if t not in names]
        if missing:
            fail(f"tools/list is missing {missing} (has {names})")
        else:
            ok(f"tools/list has {', '.join(REQUIRED_TOOLS)} ({len(names)} tools)")

        def check(label, tool, args, want=None, hebrew=False):
            try:
                text = srv.call(tool, args)
            except Exception as e:
                fail(f"{label}: {e}")
                return
            short = text.replace("\n", " | ")[:300]
            if want and want not in text:
                fail(f"{label}: '{want}' not in: {short}")
            elif hebrew and not HEBREW.search(text):
                fail(f"{label}: no Hebrew in: {short}")
            else:
                ok(f"{label}: {short}")

        check("list_upcoming_meetings", "list_upcoming_meetings", {}, want=a.upcoming)
        check("list_meetings", "list_meetings", {}, want=a.meeting)
        check("search_transcripts", "search_transcripts", {"query": "שלום"})
        if a.live:
            check("get_transcript('live')", "get_transcript", {"meeting_id": "live"}, hebrew=True)

        if a.keep_running:
            ok(f"keeping the MCP server (pid {srv.proc.pid}) open for {a.keep_running} s")
            time.sleep(a.keep_running)
    except Exception as e:
        fail(str(e))
    finally:
        if failures and srv.stderr:
            print("--- MCP server stderr (last 40 lines)")
            print("\n".join(srv.stderr[-40:]))
        srv.close()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
