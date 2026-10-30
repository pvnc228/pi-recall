"""Loopback System One worker for the Pi Recall foundation."""

from __future__ import annotations

import argparse
import contextlib
import hmac
import json
import os
from pathlib import Path
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


MODEL_NAME = "Julia-1"
MAX_BODY_BYTES = 64 * 1024
CONNECTION_READ_TIMEOUT_SECONDS = 2.0
_INVALID_BODY = object()


def _validate_request(payload: object) -> tuple[str, dict]:
    if not isinstance(payload, dict):
        raise ValueError("request must be a JSON object")
    state = payload.get("state")
    questions = payload.get("questions")
    if not isinstance(state, str) or not state.strip():
        raise ValueError("state must be a non-empty string")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions must be a non-empty object")
    for name, question in questions.items():
        if not isinstance(name, str) or not name:
            raise ValueError("question names must be non-empty strings")
        if not isinstance(question, dict) or question.get("type") != "choice":
            raise ValueError("only choice questions are supported")
        instructions = question.get("instructions")
        criteria = question.get("criteria")
        if not isinstance(instructions, str) or not instructions.strip():
            raise ValueError("choice question instructions must be a non-empty string")
        if not isinstance(criteria, dict) or not 2 <= len(criteria) <= 20:
            raise ValueError("choice questions need 2 to 20 criteria")
        for option, description in criteria.items():
            if not isinstance(option, str) or not option:
                raise ValueError("choice criteria IDs must be non-empty strings")
            if not isinstance(description, str) or not description.strip():
                raise ValueError("choice criteria descriptions must be non-empty strings")
    return state, questions


class _Handler(BaseHTTPRequestHandler):
    server: "DecisionServer"
    server_version = "pi-recall-worker"
    sys_version = ""

    def log_message(self, format: str, *args: object) -> None:
        # Never include request bodies, which may contain project prompts.
        status = args[1] if len(args) > 1 else "?"
        sys.stderr.write(f"[pi-recall-worker] {self.command} status={status}\n")

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _authorized(self) -> bool:
        value = self.headers.get("Authorization", "")
        if not value.startswith("Bearer "):
            return False
        try:
            candidate = value[7:].encode("utf-8")
            expected = self.server.token.encode("utf-8")
        except UnicodeEncodeError:
            return False
        return hmac.compare_digest(candidate, expected)

    def _send_json(self, status: int, payload: object, *, auth: bool = False) -> None:
        try:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError):
            status = 500
            body = b'{"error":{"code":"response_error","message":"response is not JSON serializable"}}'
        self.send_response(status)
        if auth:
            self.send_header("WWW-Authenticate", "Bearer")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(body)

    def _error(self, status: int, code: str, message: str, *, auth: bool = False) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}}, auth=auth)

    def _check_auth(self) -> bool:
        if self._authorized():
            return True
        self._error(401, "unauthorized", "valid bearer token required", auth=True)
        return False

    def _read_json(self) -> object:
        if self.headers.get("Transfer-Encoding"):
            self._error(400, "invalid_header", "transfer-encoding is not supported")
            return _INVALID_BODY
        value = self.headers.get("Content-Length")
        if value is None:
            self._error(411, "length_required", "content-length is required")
            return _INVALID_BODY
        try:
            length = int(value)
        except ValueError:
            self._error(400, "invalid_header", "content-length must be an integer")
            return _INVALID_BODY
        if length < 0:
            self._error(400, "invalid_header", "content-length must not be negative")
            return _INVALID_BODY
        if length > MAX_BODY_BYTES:
            self._error(413, "body_too_large", "request body exceeds 64 KiB")
            return _INVALID_BODY
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._error(415, "unsupported_media_type", "content-type must be application/json")
            return _INVALID_BODY
        raw = self.rfile.read(length)
        if len(raw) != length:
            self._error(400, "invalid_body", "request body is truncated")
            return _INVALID_BODY
        # Header/body reads are bounded; a slow model forward pass is not.
        self.connection.settimeout(None)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "invalid_json", "request body must be valid UTF-8 JSON")
            return _INVALID_BODY

    def do_GET(self) -> None:
        if not self._check_auth():
            return
        if self._path() != "/health":
            self._error(404, "not_found", "endpoint not found")
            return
        self._send_json(200, {"status": "ok", "api": "systemone", "model": MODEL_NAME})

    def do_POST(self) -> None:
        if not self._check_auth():
            return
        if self._path() != "/v1/systemone":
            self._error(404, "not_found", "endpoint not found")
            return
        payload = self._read_json()
        if payload is _INVALID_BODY:
            return
        try:
            state, questions = _validate_request(payload)
        except ValueError as exc:
            self._error(422, "invalid_request", str(exc))
            return
        if not self.server.inference_lock.acquire(blocking=False):
            self._error(429, "busy", "decision model is busy")
            return
        try:
            result = self.server.engine.predict(state=state, questions=questions)
        except Exception as exc:  # engine failures must not expose prompt or traceback
            self.server.log_engine_failure(exc)
            self._error(502, "inference_failed", "decision model inference failed")
            return
        finally:
            self.server.inference_lock.release()
        self._send_json(200, result)

    def do_PUT(self) -> None:
        if not self._check_auth():
            return
        self._error(405, "method_not_allowed", "method not allowed")

    do_PATCH = do_PUT
    do_DELETE = do_PUT
    do_OPTIONS = do_PUT
    do_HEAD = do_PUT


class DecisionServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, port: int, engine: object, token: str):
        if not token:
            raise ValueError("worker token must not be empty")
        self.engine = engine
        self.token = token
        self.inference_lock = threading.Lock()
        super().__init__(("127.0.0.1", port), _Handler)

    def get_request(self):
        request, client_address = super().get_request()
        request.settimeout(CONNECTION_READ_TIMEOUT_SECONDS)
        return request, client_address

    def log_engine_failure(self, exc: Exception) -> None:
        # Exception text can contain model input; only log its type.
        sys.stderr.write(f"[pi-recall-worker] inference failed: {type(exc).__name__}\n")


def create_server(engine: object, token: str, port: int = 0) -> DecisionServer:
    """Create a loopback server; tests may inject a fake engine here."""
    return DecisionServer(port, engine, token)


def _load_engine(model_dir: str) -> object:
    path = Path(model_dir).expanduser().resolve()
    if not path.is_dir():
        raise RuntimeError(f"Julia-1 model directory does not exist: {path}")
    # A runtime may print diagnostics while importing/loading. stdout is the
    # readiness protocol, so route those diagnostics to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        try:
            from julia import load_model
        except Exception as exc:
            raise RuntimeError("Julia-1 runtime is unavailable; install the local model runtime") from exc
        try:
            return load_model(
                str(path),
                device="cpu",
                strict_encoding=True,
                max_length=8192,
                head_length=512,
            )
        except Exception as exc:
            raise RuntimeError(f"Julia-1 model failed to load ({type(exc).__name__})") from exc


def _close_on_parent_eof(server: DecisionServer, stream: object) -> None:
    try:
        stream.read()  # type: ignore[attr-defined]
    finally:
        server.shutdown()


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pi Recall Julia-1 decision worker")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--parent-pipe", action="store_true")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    token = os.environ.get("PI_RECALL_WORKER_TOKEN")
    if not token:
        print("worker startup failed: PI_RECALL_WORKER_TOKEN is not set", file=sys.stderr)
        return 2
    try:
        engine = _load_engine(args.model_dir)
        server = create_server(engine, token, args.port)
    except Exception as exc:
        print(f"worker startup failed: {exc}", file=sys.stderr)
        return 2

    print(
        json.dumps(
            {"event": "ready", "port": server.server_port, "api": "systemone", "model": MODEL_NAME},
            separators=(",", ":"),
        ),
        flush=True,
    )
    try:
        if args.parent_pipe:
            threading.Thread(
                target=_close_on_parent_eof,
                args=(server, sys.stdin.buffer),
                daemon=True,
            ).start()
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
