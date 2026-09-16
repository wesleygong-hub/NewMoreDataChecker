import base64
import json
import tempfile
import unittest
from pathlib import Path

from auth_server import (
    AttemptLimiter,
    AuthState,
    DEFAULT_ITERATIONS,
    create_session,
    derive_password,
    verify_password,
    verify_session,
)


class AuthServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        salt = b"0123456789abcdef"
        password_hash = derive_password("correct-password", salt)
        users = {
            "version": 1,
            "users": {
                "tester": {
                    "salt": base64.b64encode(salt).decode("ascii"),
                    "password_hash": base64.b64encode(password_hash).decode("ascii"),
                    "iterations": DEFAULT_ITERATIONS,
                    "disabled": False,
                }
            },
        }
        self.users_file = root / "users.json"
        self.secret_file = root / "session-secret"
        self.users_file.write_text(json.dumps(users), encoding="utf-8")
        self.secret_file.write_text(base64.b64encode(b"s" * 32).decode("ascii"), encoding="ascii")
        self.state = AuthState(
            str(self.users_file),
            str(self.secret_file),
            "newmore_session",
            3600,
            "https://example.test",
        )

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_password_verification(self) -> None:
        self.assertTrue(verify_password(self.state.users, "tester", "correct-password", self.state.dummy))
        self.assertFalse(verify_password(self.state.users, "tester", "wrong-password", self.state.dummy))
        self.assertFalse(verify_password(self.state.users, "missing", "correct-password", self.state.dummy))

    def test_signed_session_and_expiry(self) -> None:
        token = create_session(self.state.secret, "tester", 3600, now=1000)
        self.assertEqual(verify_session(self.state.secret, token, self.state.users, now=1001), "tester")
        self.assertIsNone(verify_session(self.state.secret, token, self.state.users, now=4600))
        self.assertIsNone(verify_session(self.state.secret, f"{token}x", self.state.users, now=1001))

    def test_rate_limiter_blocks_after_five_failures(self) -> None:
        limiter = AttemptLimiter(max_failures=5, window_seconds=600, block_seconds=900)
        for attempt in range(5):
            self.assertTrue(limiter.check("client", now=1000 + attempt)[0])
            limiter.failure("client", now=1000 + attempt)
        allowed, retry_after = limiter.check("client", now=1005)
        self.assertFalse(allowed)
        self.assertGreater(retry_after, 0)
        limiter.success("client")
        self.assertTrue(limiter.check("client", now=1006)[0])


if __name__ == "__main__":
    unittest.main()
