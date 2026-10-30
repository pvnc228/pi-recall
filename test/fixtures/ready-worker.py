"""Readiness/lifecycle fixture. Never used by the production worker."""
import json
import sys

print(json.dumps({"event": "ready", "port": 12345, "api": "systemone", "model": "test-fixture"}), flush=True)
sys.stdin.read()
