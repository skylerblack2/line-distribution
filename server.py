"""Static server for the app plus a file-backed project library.

Each project lives in library/<id>/ as project.linedist.json with its audio file beside it.
Run:  python server.py [--port 8796] [--open]
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
LIBRARY = ROOT / "library"
TRASH = LIBRARY / "_trash"
PROJECT_FILE = "project.linedist.json"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,80}$")
AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac", ".webm", ".mp4"}


def project_dir(pid: str) -> Path | None:
    return LIBRARY / pid if ID_RE.match(pid) else None


def read_project(pid: str) -> dict | None:
    d = project_dir(pid)
    if d is None or not (d / PROJECT_FILE).exists():
        return None
    return json.loads((d / PROJECT_FILE).read_text(encoding="utf-8"))


def audio_path(pid: str) -> Path | None:
    d = project_dir(pid)
    if d is None or not d.exists():
        return None
    name = (read_project(pid) or {}).get("song", {}).get("audioName", "")
    if name and (d / name).is_file():
        return d / name
    return next((p for p in sorted(d.iterdir()) if p.suffix.lower() in AUDIO_EXTS), None)


def safe_name(name: str) -> str:
    return "".join(c for c in os.path.basename(name) if c not in '\\/:*?"<>|').strip() or "audio"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if self.command != "GET":
            print(time.strftime("%H:%M:%S"), self.command, unquote(self.path))

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def route(self):
        url = urlparse(self.path)
        parts = [unquote(p) for p in url.path.strip("/").split("/")]
        if parts[:2] != ["api", "projects"]:
            return None
        return parts[2:], parse_qs(url.query)

    def do_GET(self):
        r = self.route()
        if r is None:
            if urlparse(self.path).path.startswith("/library"):
                return self.send_error(404)
            return super().do_GET()
        rest, _ = r
        if not rest:
            return self.send_json(self.list_projects())
        if len(rest) == 1:
            p = read_project(rest[0])
            return self.send_json(p) if p is not None else self.send_error(404)
        if len(rest) == 2 and rest[1] == "audio":
            f = audio_path(rest[0])
            if f is None:
                return self.send_error(404)
            st = f.stat()
            modified = self.date_time_string(int(st.st_mtime))
            if self.headers.get("If-Modified-Since") == modified:
                self.send_response(304)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(st.st_size))
            self.send_header("Last-Modified", modified)
            self.end_headers()
            with open(f, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile)
            return
        self.send_error(404)

    def list_projects(self):
        rows = []
        if LIBRARY.exists():
            for d in LIBRARY.iterdir():
                f = d / PROJECT_FILE
                if not f.exists() or not ID_RE.match(d.name):
                    continue
                p = json.loads(f.read_text(encoding="utf-8"))
                song = p.get("song", {})
                rows.append({
                    "id": d.name,
                    "group": song.get("group", ""),
                    "title": song.get("title", ""),
                    "artist": song.get("artist", ""),
                    "members": len(p.get("members", [])),
                    "segments": len(p.get("segments", [])),
                    "updated": f.stat().st_mtime,
                })
        return sorted(rows, key=lambda r: -r["updated"])

    def do_PUT(self):
        r = self.route()
        if r is None or not r[0]:
            return self.send_error(404)
        rest, query = r
        d = project_dir(rest[0])
        if d is None:
            return self.send_error(400, "bad project id")
        body = self.read_body()
        if len(rest) == 1:
            project = json.loads(body)
            d.mkdir(parents=True, exist_ok=True)
            tmp = d / (PROJECT_FILE + ".tmp")
            tmp.write_text(json.dumps(project, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(d / PROJECT_FILE)
            return self.send_json({"ok": True})
        if len(rest) == 2 and rest[1] == "audio":
            name = safe_name(query.get("name", ["audio"])[0])
            d.mkdir(parents=True, exist_ok=True)
            (d / name).write_bytes(body)
            return self.send_json({"ok": True, "name": name})
        self.send_error(404)

    def do_DELETE(self):
        r = self.route()
        if r is None or len(r[0]) != 1:
            return self.send_error(404)
        d = project_dir(r[0][0])
        if d is None or not d.exists():
            return self.send_error(404)
        TRASH.mkdir(parents=True, exist_ok=True)
        shutil.move(str(d), str(TRASH / f"{d.name}-{int(time.time())}"))
        self.send_json({"ok": True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8796)
    ap.add_argument("--open", action="store_true")
    args = ap.parse_args()
    mimetypes.add_type("text/javascript", ".js")
    LIBRARY.mkdir(exist_ok=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"Line Distribution on {url}  (Ctrl+C to stop)")
    if args.open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
