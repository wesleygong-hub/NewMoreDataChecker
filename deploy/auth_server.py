#!/usr/bin/env python3
"""Small, dependency-free authentication service for newmore-datachecker."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


MAX_BODY_BYTES = 4096
DEFAULT_ITERATIONS = 310_000
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def derive_password(password: str, salt: bytes, iterations: int = DEFAULT_ITERATIONS) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)


@dataclass(frozen=True)
class UserRecord:
    salt: bytes
    password_hash: bytes
    iterations: int
    disabled: bool = False


def load_users(path: str | Path) -> dict[str, UserRecord]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    users: dict[str, UserRecord] = {}
    for username, record in raw.get("users", {}).items():
        if not USERNAME_PATTERN.fullmatch(username):
            raise ValueError(f"Invalid username in credential file: {username!r}")
        users[username] = UserRecord(
            salt=base64.b64decode(record["salt"], validate=True),
            password_hash=base64.b64decode(record["password_hash"], validate=True),
            iterations=int(record.get("iterations", DEFAULT_ITERATIONS)),
            disabled=bool(record.get("disabled", False)),
        )
    if not users:
        raise ValueError("Credential file contains no users")
    return users


def load_secret(path: str | Path) -> bytes:
    secret = base64.b64decode(Path(path).read_text(encoding="ascii").strip(), validate=True)
    if len(secret) < 32:
        raise ValueError("Session secret must contain at least 32 bytes")
    return secret


def verify_password(users: dict[str, UserRecord], username: str, password: str, dummy: UserRecord) -> bool:
    record = users.get(username, dummy)
    candidate = derive_password(password, record.salt, record.iterations)
    matches = hmac.compare_digest(candidate, record.password_hash)
    return record is not dummy and not record.disabled and matches


def create_session(secret: bytes, username: str, ttl_seconds: int, now: int | None = None) -> str:
    issued_at = int(time.time() if now is None else now)
    payload = {
        "sub": username,
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
        "nonce": _b64url_encode(secrets.token_bytes(12)),
    }
    encoded = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64url_encode(hmac.new(secret, encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def verify_session(
    secret: bytes,
    token: str,
    users: dict[str, UserRecord],
    now: int | None = None,
) -> str | None:
    try:
        encoded, supplied_signature = token.split(".", 1)
        expected_signature = _b64url_encode(
            hmac.new(secret, encoded.encode("ascii"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(supplied_signature, expected_signature):
            return None
        payload = json.loads(_b64url_decode(encoded))
        username = payload["sub"]
        expires_at = int(payload["exp"])
        current_time = int(time.time() if now is None else now)
        record = users.get(username)
        if not isinstance(username, str) or expires_at <= current_time or not record or record.disabled:
            return None
        return username
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


class AttemptLimiter:
    def __init__(self, max_failures: int = 5, window_seconds: int = 600, block_seconds: int = 900):
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self.block_seconds = block_seconds
        self._failures: dict[str, list[float]] = {}
        self._blocked_until: dict[str, float] = {}
        self._lock = threading.Lock()

    def check(self, key: str, now: float | None = None) -> tuple[bool, int]:
        current = time.time() if now is None else now
        with self._lock:
            blocked_until = self._blocked_until.get(key, 0)
            if blocked_until > current:
                return False, max(1, int(blocked_until - current))
            self._blocked_until.pop(key, None)
            recent = [stamp for stamp in self._failures.get(key, []) if stamp >= current - self.window_seconds]
            self._failures[key] = recent
            return True, 0

    def failure(self, key: str, now: float | None = None) -> None:
        current = time.time() if now is None else now
        with self._lock:
            recent = [stamp for stamp in self._failures.get(key, []) if stamp >= current - self.window_seconds]
            recent.append(current)
            self._failures[key] = recent
            if len(recent) >= self.max_failures:
                self._blocked_until[key] = current + self.block_seconds
                self._failures[key] = []

    def success(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)
            self._blocked_until.pop(key, None)


class AuthState:
    def __init__(
        self,
        users_file: str,
        secret_file: str,
        cookie_name: str,
        ttl_seconds: int,
        allowed_origin: str,
    ):
        self.users_file = users_file
        self.users = load_users(users_file)
        self.secret = load_secret(secret_file)
        dummy_salt = hmac.new(self.secret, b"newmore-dummy-salt", hashlib.sha256).digest()[:16]
        self.dummy = UserRecord(
            salt=dummy_salt,
            password_hash=derive_password("invalid-password", dummy_salt),
            iterations=DEFAULT_ITERATIONS,
        )
        self.cookie_name = cookie_name
        self.ttl_seconds = ttl_seconds
        self.allowed_origin = allowed_origin.rstrip("/")
        self.limiter = AttemptLimiter()

    def reload_users(self) -> None:
        self.users = load_users(self.users_file)


STATE: AuthState


class AuthHandler(BaseHTTPRequestHandler):
    server_version = "NewMoreAuth/1.0"
    sys_version = ""

    def _send_json(self, status: int, payload: dict[str, Any], headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin", "").rstrip("/")
        return bool(origin) and hmac.compare_digest(origin, STATE.allowed_origin)

    def _client_key(self) -> str:
        return self.headers.get("X-Real-IP", self.client_address[0]).split(",", 1)[0].strip()

    def _session_user(self) -> str | None:
        cookie_header = self.headers.get("Cookie", "")
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
        except Exception:
            return None
        morsel = cookie.get(STATE.cookie_name)
        if not morsel:
            return None
        return verify_session(STATE.secret, morsel.value, STATE.users)

    def _login(self) -> None:
        if not self._origin_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "message": "Invalid origin"})
            return
        client_key = self._client_key()
        allowed, retry_after = STATE.limiter.check(client_key)
        if not allowed:
            self._send_json(
                HTTPStatus.TOO_MANY_REQUESTS,
                {"ok": False, "message": "Too many attempts"},
                {"Retry-After": str(retry_after)},
            )
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Invalid request"})
            return
        try:
            payload = json.loads(self.rfile.read(content_length))
            username = str(payload.get("username", "")).strip()
            password = payload.get("password", "")
            if not USERNAME_PATTERN.fullmatch(username) or not isinstance(password, str) or len(password) > 256:
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "message": "Invalid request"})
            return
        if not verify_password(STATE.users, username, password, STATE.dummy):
            STATE.limiter.failure(client_key)
            self._send_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "message": "Invalid credentials"})
            return
        STATE.limiter.success(client_key)
        token = create_session(STATE.secret, username, STATE.ttl_seconds)
        cookie = (
            f"{STATE.cookie_name}={token}; Path=/; Max-Age={STATE.ttl_seconds}; "
            "Secure; HttpOnly; SameSite=Strict"
        )
        self._send_json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": cookie})

    def _verify(self) -> None:
        username = self._session_user()
        if not username:
            self._send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Authenticated-User", username)
        self.end_headers()

    def _logout(self) -> None:
        if not self._origin_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "message": "Invalid origin"})
            return
        cookie = (
            f"{STATE.cookie_name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; "
            "Secure; HttpOnly; SameSite=Strict"
        )
        self._send_json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": cookie})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(HTTPStatus.OK, {"ok": True})
        elif self.path == "/verify":
            self._verify()
        else:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False})

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/login":
            self._login()
        elif self.path == "/logout":
            self._logout()
        else:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False})

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)


def main() -> None:
    global STATE
    bind = os.environ.get("NEWMORE_AUTH_BIND", "127.0.0.1")
    port = int(os.environ.get("NEWMORE_AUTH_PORT", "18080"))
    users_file = os.environ["NEWMORE_AUTH_USERS_FILE"]
    secret_file = os.environ["NEWMORE_AUTH_SECRET_FILE"]
    cookie_name = os.environ.get("NEWMORE_AUTH_COOKIE", "newmore_session")
    ttl_seconds = int(os.environ.get("NEWMORE_AUTH_TTL_SECONDS", "43200"))
    allowed_origin = os.environ["NEWMORE_AUTH_ALLOWED_ORIGIN"]
    STATE = AuthState(users_file, secret_file, cookie_name, ttl_seconds, allowed_origin)

    signal.signal(signal.SIGHUP, lambda _signum, _frame: STATE.reload_users())
    server = ThreadingHTTPServer((bind, port), AuthHandler)
    server.daemon_threads = True
    print(f"newmore auth listening on {bind}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
