#!/usr/bin/env python3
"""Separate, explicitly invoked MCP adapter for the hourly fact writer."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26")
SINCE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
TOOL = {"name": "sync_hourly_fact", "description": "按明确时间下界手动交付本机已核验的小时事实行",
        "inputSchema": {"type": "object", "properties": {
            "since": {"type": "string", "description": "UTC ISO 毫秒时间，限定采样和小时下界"},
            "execute": {"type": "boolean", "description": "必须明确为 true"}},
            "required": ["since", "execute"], "additionalProperties": False},
        "annotations": {"readOnlyHint": False, "destructiveHint": False,
                        "idempotentHint": True, "openWorldHint": True}}


def run_sync(args, runner=subprocess.run, node=None):
    if (not isinstance(args, dict) or set(args) != {"since", "execute"} or
            args["execute"] is not True or not isinstance(args["since"], str) or
            not SINCE.fullmatch(args["since"])):
        return {"error": {"code": "INVALID_ARGUMENTS", "message": "需明确执行并提供 UTC ISO 毫秒时间"}}
    executable = node or os.environ.get("LIVEOPS_NODE") or shutil.which("node")
    if not executable:
        return {"error": {"code": "NODE_UNAVAILABLE", "message": "本机 Node.js 未配置"}}
    script = Path(__file__).resolve().parent / "scripts" / "sync_hourly_fact.mjs"
    try:
        result = runner([executable, str(script), "--execute=true", "--since=" + args["since"],
                         "--limit=1"],
                        capture_output=True, text=True, timeout=180, check=False)
        if result.returncode != 0:
            return {"error": {"code": "SYNC_FAILED", "message": "小时事实交付失败；待同步状态保留，请在本机检查"}}
        data = json.loads(result.stdout)
        if (not isinstance(data, dict) or set(data) != {"delivered", "pending", "deferred"} or
                any(type(value) is not int or value < 0 for value in data.values())):
            raise ValueError("invalid counters")
        return data
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {"error": {"code": "SYNC_UNAVAILABLE", "message": "小时事实交付未能确认；请在本机检查待同步状态"}}


def dispatch(request, sync=run_sync):
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": request.get("id") if isinstance(request, dict) else None,
                "error": {"code": -32600, "message": "Invalid Request"}}
    if "id" not in request:
        return None
    identifier = request["id"]
    method = request.get("method")
    if method == "initialize":
        params = request.get("params", {})
        version = params.get("protocolVersion") if isinstance(params, dict) else None
        result = {"protocolVersion": version if version in PROTOCOLS else PROTOCOLS[0],
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "liveops-hourly-fact-manual", "version": "1.0.0"}}
    elif method == "tools/list":
        result = {"tools": [TOOL]}
    elif method == "tools/call":
        params = request.get("params", {})
        if not isinstance(params, dict) or params.get("name") != TOOL["name"]:
            return {"jsonrpc": "2.0", "id": identifier,
                    "error": {"code": -32602, "message": "Invalid params"}}
        data = sync(params.get("arguments"))
        result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
                  "structuredContent": data, "isError": "error" in data}
    else:
        return {"jsonrpc": "2.0", "id": identifier,
                "error": {"code": -32601, "message": "Method not found"}}
    return {"jsonrpc": "2.0", "id": identifier, "result": result}


def main():
    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
            response = dispatch(request)
        except (ValueError, UnicodeError, RecursionError):
            response = {"jsonrpc": "2.0", "id": None,
                        "error": {"code": -32700, "message": "Parse error"}}
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
