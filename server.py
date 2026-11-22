#!/usr/bin/env python3
"""WikiLLM - a local, Wikipedia-style front end for a local language model.

Run:  python3 server.py [--port 8917] [--no-browser]

Standard library only. The server does three things:
  * serves the web page in ./static
  * forwards chat requests to the OpenAI-compatible API you configure
    (LM Studio, Ollama, llama.cpp, vLLM, ...), streaming the reply back
  * stores settings in ./config.json and generated articles in ./cache

Starting values for the connection can be given in a .env file or in
environment variables (see .env.example); settings saved in the app win.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CACHE = ROOT / "cache"
CONFIG_PATH = ROOT / "config.json"

DEFAULT_CONFIG = {
    "baseUrl": "http://localhost:1234/v1",
    "apiKey": "",
    "model": "",
    "temperature": 0.7,
    "maxTokens": 8000,
    "parallel": 6,             # requests sent at once while building a page
    "reasoning": "",           # reasoning_effort: "" (model default) | high | medium | low
    "length": "standard",      # short | standard | long
    "illustrations": False,
    "extraInstructions": "",
}

INT_LIMITS = {"maxTokens": (64, 1000000), "parallel": (1, 6)}
EFFORTS = ("", "high", "medium", "low")

KNOWN_SERVERS = [
    ("LM Studio", "http://localhost:1234/v1"),
    ("Ollama", "http://localhost:11434/v1"),
    ("llama.cpp", "http://localhost:8080/v1"),
    ("vLLM", "http://localhost:8000/v1"),
    ("Jan", "http://localhost:1337/v1"),
    ("KoboldCpp", "http://localhost:5001/v1"),
    ("text-generation-webui", "http://localhost:5000/v1"),
]

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
}

MAX_BODY = 8 * 1024 * 1024
lock = threading.Lock()
# Never route model requests through a system HTTP proxy: this is local-only.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------- config

# Environment variable -> setting. Read from the real environment and from ./.env.
ENV_SETTINGS = {
    "WIKILLM_BASE_URL": "baseUrl",
    "WIKILLM_API_KEY": "apiKey",
    "WIKILLM_MODEL": "model",
}


def read_env(path):
    """WIKILLM_* values from a .env file (KEY=value lines), overridden by the environment."""
    values = {}
    try:
        lines = path.read_text("utf-8").splitlines()
    except OSError:
        lines = []
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export "):]
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    for key, value in os.environ.items():
        if key.startswith("WIKILLM_"):
            values[key] = value
    return {k: v for k, v in values.items() if k.startswith("WIKILLM_") and v}


ENV = read_env(ROOT / ".env")


def load_config():
    """Built-in defaults, then .env / environment, then whatever was saved in the app."""
    cfg = dict(DEFAULT_CONFIG)
    for name, key in ENV_SETTINGS.items():
        if name in ENV:
            cfg[key] = ENV[name]
    try:
        saved = json.loads(CONFIG_PATH.read_text("utf-8"))
        for key in DEFAULT_CONFIG:
            if key in saved:
                cfg[key] = saved[key]
    except (OSError, ValueError):
        pass
    return cfg


def save_config(changes):
    with lock:
        cfg = load_config()
        for key, default in DEFAULT_CONFIG.items():
            if key not in changes:
                continue
            value = changes[key]
            try:
                if isinstance(default, bool):
                    value = bool(value)
                elif isinstance(default, float):
                    value = max(0.0, min(2.0, float(value)))
                elif isinstance(default, int):
                    low, high = INT_LIMITS[key]
                    value = max(low, min(high, int(value)))
                else:
                    value = str(value).strip()
            except (TypeError, ValueError):
                continue
            cfg[key] = value
        if cfg["length"] not in ("short", "standard", "long"):
            cfg["length"] = "standard"
        if cfg["reasoning"] not in EFFORTS:
            cfg["reasoning"] = ""
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), "utf-8")
        return cfg


# ---------------------------------------------------------------- upstream

def upstream(base_url, api_key, path, payload=None, timeout=900):
    url = base_url.rstrip("/") + path
    if not re.match(r"^https?://", url):
        raise ValueError("The API base URL must start with http:// or https://")
    headers = {"Accept": "application/json, text/event-stream"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if data else "GET")
    return opener.open(req, timeout=timeout)


def describe_error(exc):
    """Turn an upstream failure into (message, detail)."""
    if isinstance(exc, urllib.error.HTTPError):
        detail = exc.read().decode("utf-8", "replace")[:2000]
        message = "The model server answered with HTTP %d" % exc.code
        try:
            err = json.loads(detail).get("error")
            if isinstance(err, dict):
                err = err.get("message")
            if err:
                message += ": " + str(err)
        except (ValueError, AttributeError):
            pass
        return message, detail
    if isinstance(exc, urllib.error.URLError):
        return "Could not reach the model server (%s)" % exc.reason, ""
    return "Could not reach the model server (%s)" % exc, ""


def list_models(base_url, api_key, timeout=6):
    with upstream(base_url, api_key, "/models", timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    items = data.get("data") if isinstance(data, dict) else data
    return [m["id"] for m in (items or []) if isinstance(m, dict) and m.get("id")]


def detect_servers():
    found = []

    def probe(name, url):
        try:
            models = list_models(url, "", timeout=1.5)
            found.append({"name": name, "baseUrl": url, "models": models})
        except Exception:
            pass

    threads = [threading.Thread(target=probe, args=s) for s in KNOWN_SERVERS]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    order = [s[1] for s in KNOWN_SERVERS]
    found.sort(key=lambda f: order.index(f["baseUrl"]))
    return found


# ---------------------------------------------------------------- page cache

def page_key(title):
    return re.sub(r"\s+", " ", str(title).replace("_", " ")).strip().lower()


def page_path(title):
    key = page_key(title)
    slug = re.sub(r"[^a-z0-9]+", "-", key).strip("-")[:60] or "page"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
    return CACHE / ("%s-%s.json" % (slug, digest))


def page_meta(rec):
    return {
        "title": rec.get("title", ""),
        "type": rec.get("type", "article"),
        "model": rec.get("model", ""),
        "generatedAt": rec.get("generatedAt", ""),
        "categories": rec.get("categories", []),
    }


INDEX = {}


def build_index():
    CACHE.mkdir(exist_ok=True)
    for path in CACHE.glob("*.json"):
        try:
            rec = json.loads(path.read_text("utf-8"))
            INDEX[page_key(rec["title"])] = page_meta(rec)
        except (OSError, ValueError, KeyError):
            continue


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "WikiLLM/1.0"
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        # Stay quiet except for model requests and errors.
        status = str(args[1]) if len(args) > 1 else ""
        if "/api/chat" in (getattr(self, "path", "") or "") or status[:1] in ("4", "5"):
            sys.stderr.write("  %s\n" % (fmt % args))

    # -- helpers

    def send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        try:
            body = path.read_bytes()
        except OSError:
            return self.send_json(404, {"error": "Not found"})
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def local_only(self):
        """Refuse anything not addressed to this machine by a page it served.

        Blocks other websites (and DNS-rebinding tricks) from driving the
        model or reading the settings through the visitor's browser.
        """
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in ("localhost", "127.0.0.1", "::1"):
            self.send_json(403, {"error": "WikiLLM only answers on localhost"})
            return False
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get("Host"):
            self.send_json(403, {"error": "Cross-origin requests are not allowed"})
            return False
        return True

    def read_json(self):
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            self.send_json(415, {"error": "Expected application/json"})
            return None
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self.send_json(400, {"error": "Missing or oversized request body"})
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            self.send_json(400, {"error": "Invalid JSON"})
            return None

    def route(self):
        parts = urllib.parse.urlsplit(self.path)
        return parts.path, urllib.parse.parse_qs(parts.query)

    # -- methods

    def do_GET(self):
        if not self.local_only():
            return
        path, query = self.route()
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/wiki/Main_Page")
            self.end_headers()
        elif path.startswith("/wiki/") or path == "/wiki":
            self.send_file(STATIC / "index.html")
        elif path.startswith("/static/"):
            target = (STATIC / path[len("/static/"):]).resolve()
            if STATIC.resolve() not in target.parents:
                return self.send_json(404, {"error": "Not found"})
            self.send_file(target)
        elif path == "/favicon.ico":
            self.send_file(STATIC / "favicon.svg")
        elif path == "/api/config":
            self.send_json(200, load_config())
        elif path == "/api/detect":
            self.send_json(200, {"servers": detect_servers()})
        elif path == "/api/pages":
            with lock:
                pages = sorted(INDEX.values(), key=lambda m: m["generatedAt"], reverse=True)
            self.send_json(200, {"pages": pages})
        elif path == "/api/page":
            target = page_path(query.get("title", [""])[0])
            try:
                self.send_json(200, json.loads(target.read_text("utf-8")))
            except (OSError, ValueError):
                self.send_json(404, {"error": "Not generated yet"})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if not self.local_only():
            return
        path, _ = self.route()
        body = self.read_json()
        if body is None:
            return
        if path == "/api/config":
            self.send_json(200, save_config(body))
        elif path == "/api/test":
            cfg = load_config()
            base = str(body.get("baseUrl") or cfg["baseUrl"])
            key = str(body.get("apiKey") if "apiKey" in body else cfg["apiKey"])
            try:
                self.send_json(200, {"ok": True, "models": list_models(base, key)})
            except Exception as exc:
                self.send_json(200, {"ok": False, "error": describe_error(exc)[0]})
        elif path == "/api/chat":
            self.chat(body)
        else:
            self.send_json(404, {"error": "Not found"})

    def do_PUT(self):
        if not self.local_only():
            return
        path, _ = self.route()
        if path != "/api/page":
            return self.send_json(404, {"error": "Not found"})
        rec = self.read_json()
        if rec is None:
            return
        if not isinstance(rec, dict) or not page_key(rec.get("title", "")):
            return self.send_json(400, {"error": "A page needs a title"})
        with lock:
            CACHE.mkdir(exist_ok=True)
            page_path(rec["title"]).write_text(json.dumps(rec, indent=1), "utf-8")
            INDEX[page_key(rec["title"])] = page_meta(rec)
        self.send_json(200, {"ok": True})

    def do_DELETE(self):
        if not self.local_only():
            return
        path, query = self.route()
        if path == "/api/page":
            title = query.get("title", [""])[0]
            with lock:
                INDEX.pop(page_key(title), None)
                try:
                    page_path(title).unlink()
                except OSError:
                    pass
            self.send_json(200, {"ok": True})
        elif path == "/api/pages":
            with lock:
                INDEX.clear()
                shutil.rmtree(str(CACHE), ignore_errors=True)
                CACHE.mkdir(exist_ok=True)
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "Not found"})

    # -- model proxy

    def chat(self, body):
        cfg = load_config()
        if not cfg["model"]:
            return self.send_json(400, {"error": "No model has been chosen yet"})
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return self.send_json(400, {"error": "No messages"})
        payload = {
            "model": cfg["model"],
            "messages": messages,
            "stream": True,
            "temperature": body.get("temperature", cfg["temperature"]),
            "max_tokens": body.get("max_tokens", cfg["maxTokens"]),
        }
        # Optional extras: the real token count at the end of the stream, and how hard a
        # reasoning model should think. A server that rejects them is asked again without.
        extras = {"stream_options": {"include_usage": True}}
        effort = body.get("reasoning_effort", cfg["reasoning"])
        if effort in EFFORTS and effort:
            extras["reasoning_effort"] = effort
        try:
            try:
                resp = upstream(cfg["baseUrl"], cfg["apiKey"], "/chat/completions",
                                dict(payload, **extras))
            except urllib.error.HTTPError as exc:
                if exc.code not in (400, 422):
                    raise
                resp = upstream(cfg["baseUrl"], cfg["apiKey"], "/chat/completions", payload)
        except Exception as exc:
            message, detail = describe_error(exc)
            return self.send_json(502, {"error": message, "detail": detail})

        self.send_response(200)
        self.send_header("Content-Type",
                         resp.headers.get("Content-Type") or "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            while True:
                line = resp.readline()
                if not line:
                    break
                self.wfile.write(line)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # reader navigated away or pressed Stop
        finally:
            # Closing the upstream connection tells the model server to stop.
            resp.close()


def main():
    parser = argparse.ArgumentParser(description="WikiLLM local server")
    try:
        port = int(ENV.get("WIKILLM_PORT", 8917))
    except ValueError:
        port = 8917
    parser.add_argument("--port", type=int, default=port)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    build_index()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        sys.exit("Could not start on port %d (%s). Try: python3 server.py --port 8700"
                 % (args.port, exc))
    server.daemon_threads = True
    url = "http://localhost:%d/" % args.port
    print("WikiLLM is running at %s   (Ctrl+C to stop)" % url)
    if not args.no_browser:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
