#!/usr/bin/env python3
"""Create or update an auth user without exposing the password on the command line."""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import secrets
import tempfile
from pathlib import Path

from auth_server import DEFAULT_ITERATIONS, USERNAME_PATTERN, derive_password


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--users-file", required=True)
    parser.add_argument("--secret-file", required=True)
    parser.add_argument("--username", required=True)
    args = parser.parse_args()

    if not USERNAME_PATTERN.fullmatch(args.username):
        raise SystemExit("Username may contain only letters, numbers, dot, underscore and hyphen")

    password = getpass.getpass("Password: ")
    confirmation = getpass.getpass("Confirm password: ")
    if password != confirmation:
        raise SystemExit("Passwords do not match")
    if len(password) < 8:
        raise SystemExit("Password must contain at least 8 characters")

    users_path = Path(args.users_file)
    if users_path.exists():
        document = json.loads(users_path.read_text(encoding="utf-8"))
    else:
        document = {"version": 1, "users": {}}

    salt = secrets.token_bytes(16)
    password_hash = derive_password(password, salt, DEFAULT_ITERATIONS)
    document.setdefault("users", {})[args.username] = {
        "salt": base64.b64encode(salt).decode("ascii"),
        "password_hash": base64.b64encode(password_hash).decode("ascii"),
        "iterations": DEFAULT_ITERATIONS,
        "disabled": False,
    }
    atomic_write(users_path, json.dumps(document, ensure_ascii=False, indent=2) + "\n")

    secret_path = Path(args.secret_file)
    if not secret_path.exists():
        atomic_write(secret_path, base64.b64encode(secrets.token_bytes(32)).decode("ascii") + "\n")

    password = ""
    confirmation = ""
    print(f"Updated user {args.username!r}; credentials and session secret are mode 0600")


if __name__ == "__main__":
    main()
