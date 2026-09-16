#!/usr/bin/env python3
"""Interactive production smoke test; never accepts the password as an argument."""

from __future__ import annotations

import argparse
import getpass
import http.cookiejar
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def request(opener: urllib.request.OpenerDirector, target: str, **kwargs):  # type: ignore[no-untyped-def]
    try:
        return opener.open(urllib.request.Request(target, **kwargs), timeout=10)
    except urllib.error.HTTPError as error:
        return error


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--ca-file", required=True)
    parser.add_argument("--username", required=True)
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    parsed = urllib.parse.urlsplit(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    context = ssl.create_default_context(cafile=args.ca_file)
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=context),
        NoRedirect(),
        urllib.request.HTTPCookieProcessor(cookies),
    )

    unauthenticated = request(opener, base_url + "/")
    if unauthenticated.status != 302 or "/login.html" not in unauthenticated.headers.get("Location", ""):
        raise SystemExit("Unauthenticated request was not redirected to login")

    password = getpass.getpass("Password: ")
    payload = json.dumps({"username": args.username, "password": password}).encode("utf-8")
    login = request(
        opener,
        base_url + "/api/login",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json", "Origin": origin},
    )
    password = ""
    if login.status != 200:
        raise SystemExit(f"Login failed with HTTP {login.status}")

    protected = request(opener, base_url + "/")
    body = protected.read().decode("utf-8", errors="replace")
    if protected.status != 200 or "牛马对账" not in body:
        raise SystemExit("Authenticated application request failed")

    logout = request(
        opener,
        base_url + "/api/logout",
        data=b"{}",
        method="POST",
        headers={"Content-Type": "application/json", "Origin": origin},
    )
    if logout.status != 200:
        raise SystemExit(f"Logout failed with HTTP {logout.status}")

    after_logout = request(opener, base_url + "/")
    if after_logout.status != 302:
        raise SystemExit("Session remained active after logout")
    print("Authentication smoke test passed")


if __name__ == "__main__":
    main()
