"""Development-only HTTP receiver for inspecting LiveKit webhook delivery."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def redact_sensitive_fields(value: Any) -> Any:
    """Remove ephemeral credentials before writing webhook bodies to logs."""
    if isinstance(value, dict):
        return {
            key: "<redacted>"
            if key.lower() in {"turnpassword", "token", "secret"}
            else redact_sensitive_fields(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_sensitive_fields(item) for item in value]
    return value


class WebhookHandler(BaseHTTPRequestHandler):
    server_version = "LiveKitWebhookTestReceiver/1.0"

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.path != "/health":
            self.send_error(404)
            return

        self._send_json(200, {"status": "ok"})

    def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.path != "/webhook":
            self.send_error(404)
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)

        try:
            body: Any = json.loads(raw_body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = raw_body.decode("utf-8", errors="replace")

        record = {
            "authorization_present": bool(self.headers.get("Authorization")),
            "content_type": self.headers.get("Content-Type"),
            "body": redact_sensitive_fields(body),
        }
        print("LIVEKIT_WEBHOOK " + json.dumps(record, ensure_ascii=False), flush=True)
        self._send_json(200, {"status": "accepted"})

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send_json(self, status: int, payload: dict[str, str]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8080), WebhookHandler)
    print("Webhook test receiver listening on :8080", flush=True)
    server.serve_forever()
