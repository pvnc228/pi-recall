import contextlib
import io
import json
from pathlib import Path
import socket
import sys
import threading
import time
from types import SimpleNamespace
from email.message import Message
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).parents[1]))
import worker  # noqa: E402


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()
        self.block = False
        self.started = threading.Event()
        self.release = threading.Event()

    def predict(self, *, state, questions):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.calls.append((state, questions))
        try:
            if self.block:
                self.started.set()
                self.release.wait(2)
            else:
                time.sleep(0.03)
        finally:
            with self.lock:
                self.active -= 1
        return {"answers": {"route": {"choice": "keep"}}}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.server = worker.create_server(self.engine, "secret")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None, token="secret", headers=None):
        headers = dict(headers or {})
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            headers.setdefault("Content-Type", "application/json")
            headers.setdefault("Content-Length", str(len(data)))
        request = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=2) as response:
                return response.status, json.loads(response.read())
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def valid_body(self):
        return {
            "state": "The user asks about a project decision.",
            "questions": {
                "route": {
                    "type": "choice",
                    "instructions": "Which route applies?",
                    "criteria": {"keep": "Keep the existing memory.", "skip": "Skip it."},
                }
            },
        }

    def test_health_requires_token(self):
        self.assertEqual(self.request("GET", "/health", token=None)[0], 401)
        status, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["api"], "systemone")

    def test_choice_response_and_engine_input(self):
        status, body = self.request("POST", "/v1/systemone", self.valid_body())
        self.assertEqual(status, 200)
        self.assertEqual(body["answers"]["route"]["choice"], "keep")
        self.assertEqual(self.engine.calls[0][0], self.valid_body()["state"])

    def test_auth_and_request_validation(self):
        self.assertEqual(self.request("POST", "/v1/systemone", self.valid_body(), token="wrong")[0], 401)
        invalid = self.valid_body()
        invalid["questions"]["route"]["type"] = "score"
        status, body = self.request("POST", "/v1/systemone", invalid)
        self.assertEqual(status, 422)
        self.assertEqual(body["error"]["code"], "invalid_request")
        status, body = self.request(
            "POST", "/v1/systemone", b"{}", headers={"Content-Type": "text/plain"}
        )
        self.assertEqual(status, 415)
        self.assertEqual(body["error"]["code"], "unsupported_media_type")
        status, body = self.request("POST", "/v1/systemone", b"null")
        self.assertEqual(status, 422)
        self.assertEqual(body["error"]["code"], "invalid_request")

    def test_non_ascii_auth_uses_bytes_comparison(self):
        headers = Message()
        headers["Authorization"] = "Bearer séc рет"
        handler = object.__new__(worker._Handler)
        handler.headers = headers
        handler.server = SimpleNamespace(token="séc рет")
        self.assertTrue(worker._Handler._authorized(handler))

    def test_body_limit_and_invalid_json(self):
        oversized = b"x" * (worker.MAX_BODY_BYTES + 1)
        status, body = self.request(
            "POST", "/v1/systemone", oversized, headers={"Content-Type": "application/json"}
        )
        self.assertEqual(status, 413)
        self.assertEqual(body["error"]["code"], "body_too_large")
        status, body = self.request("POST", "/v1/systemone", b"not-json")
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_json")
        status, body = self.request("POST", "/v1/systemone", None)
        self.assertEqual(status, 415)
        self.assertEqual(body["error"]["code"], "unsupported_media_type")

    def test_inference_is_serialized(self):
        body = self.valid_body()
        threads = [threading.Thread(target=self.request, args=("POST", "/v1/systemone", body)) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)
        self.assertEqual(self.engine.max_active, 1)

    def test_busy_request_is_not_queued(self):
        self.engine.block = True
        first_result = []
        first = threading.Thread(
            target=lambda: first_result.append(self.request("POST", "/v1/systemone", self.valid_body()))
        )
        first.start()
        self.assertTrue(self.engine.started.wait(2))
        status, body = self.request("POST", "/v1/systemone", self.valid_body())
        self.assertEqual(status, 429)
        self.assertEqual(body["error"]["code"], "busy")
        self.engine.release.set()
        first.join(timeout=2)
        self.assertEqual(first_result[0][0], 200)

    def test_incomplete_headers_time_out(self):
        old_timeout = worker.CONNECTION_READ_TIMEOUT_SECONDS
        worker.CONNECTION_READ_TIMEOUT_SECONDS = 0.15
        server = worker.create_server(FakeEngine(), "secret")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = socket.create_connection(("127.0.0.1", server.server_port), timeout=2)
        try:
            client.sendall(b"GET /health HTTP/1.1\r\n")
            self.assertEqual(client.recv(1), b"")
        finally:
            client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            worker.CONNECTION_READ_TIMEOUT_SECONDS = old_timeout

    def test_model_loader_diagnostics_do_not_pollute_stdout(self):
        import tempfile
        import types

        fake_julia = types.ModuleType("julia")

        def load_model(*args, **kwargs):
            print("runtime diagnostic")
            return object()

        fake_julia.load_model = load_model
        previous = sys.modules.get("julia")
        sys.modules["julia"] = fake_julia
        try:
            with tempfile.TemporaryDirectory() as model_dir, io.StringIO() as stdout, io.StringIO() as stderr:
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    worker._load_engine(model_dir)
                self.assertEqual(stdout.getvalue(), "")
                self.assertIn("runtime diagnostic", stderr.getvalue())
        finally:
            if previous is None:
                sys.modules.pop("julia", None)
            else:
                sys.modules["julia"] = previous

    def test_parent_eof_shutdown(self):
        stopper = threading.Thread(
            target=worker._close_on_parent_eof, args=(self.server, io.BytesIO()), daemon=True
        )
        stopper.start()
        stopper.join(timeout=2)
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())


if __name__ == "__main__":
    unittest.main()
