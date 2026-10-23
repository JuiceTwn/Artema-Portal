#!/usr/bin/env python3
"""Artema Portal: a tiny self-hosted file hand-off for the shop.

One file, standard library only.

  * Main computer  -> serves the web app and keeps files in  Desktop\\Artema Portal
  * Other computers -> a background sync agent mirrors that folder to their own desktop

Run it with no arguments for the setup wizard. Everything after that is automatic.
"""
from __future__ import annotations

import ctypes
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "0.1.0"
APP_NAME = "Artema Portal"
DEFAULT_PORT = 8080
LOCAL_PORT = int(os.environ.get("ARTEMA_LOCAL_PORT") or 8787)   # this computer's own setup/launch page (loopback only)
SYNC_SECONDS = 3
ONLINE_SECONDS = 12
STARTER_FOLDERS = ["To CNC", "From CNC", "Drawings", "Photos"]

FROZEN = bool(getattr(sys, "frozen", False))     # True when running as the packaged .exe
HERE = Path(getattr(sys, "_MEIPASS", None) or Path(__file__).resolve().parent)
WEB = HERE / "web"
DATA = Path(os.environ.get("ARTEMA_DATA") or (Path(os.environ.get("APPDATA") or Path.home()) / "ArtemaPortal"))
TESTING = bool(os.environ.get("ARTEMA_TEST"))   # skips startup/shortcut/firewall changes

mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("application/octet-stream", ".dxf")
mimetypes.add_type("application/octet-stream", ".dwg")


# --------------------------------------------------------------------------- helpers

def log(msg: str) -> None:
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        p = DATA / "portal.log"
        if p.exists() and p.stat().st_size > 1_000_000:
            p.replace(DATA / "portal.old.log")
        with open(p, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}\n")
    except OSError:
        pass


def read_json(path: Path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def desktop_dir() -> Path:
    override = os.environ.get("ARTEMA_DESKTOP")
    if override:
        return Path(override)
    if os.name == "nt":
        try:
            buf = ctypes.create_unicode_buffer(260)
            if ctypes.windll.shell32.SHGetFolderPathW(None, 0x10, None, 0, buf) == 0:   # follows OneDrive redirects
                return Path(buf.value)
        except Exception:
            pass
    return Path.home() / "Desktop"


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ignored(name: str) -> bool:
    n = name.lower()
    return (n.startswith(".") or n.startswith("~$") or n in ("desktop.ini", "thumbs.db")
            or n.endswith((".tmp", ".part", ".crdownload")))


_BAD_CHARS = re.compile(r'[<>:"|?*\x00-\x1f]')


def hide(path: Path) -> None:
    if os.name == "nt":
        try:
            ctypes.windll.kernel32.SetFileAttributesW(str(path), 0x2)
        except Exception:
            pass


def norm_addr(addr: str) -> str:
    addr = (addr or "").strip().replace("http://", "").replace("https://", "").strip("/")
    if not addr:
        raise ValueError("Enter the main computer's address")
    if ":" not in addr:
        addr += f":{DEFAULT_PORT}"
    return addr


def now() -> float:
    return time.time()


# --------------------------------------------------------------------------- host storage

class Store:
    """Everything the main computer knows: the folder, who added what, which PCs exist."""

    def __init__(self, root: Path, host_name: str):
        fresh = not root.exists()
        root.mkdir(parents=True, exist_ok=True)
        if fresh:
            for n in STARTER_FOLDERS:
                (root / n).mkdir(exist_ok=True)
        self.root = root
        self.host_name = host_name
        self.trash = root / ".trash"
        self.lock = threading.RLock()
        self.meta: dict = read_json(DATA / "meta.json", {})
        self.devices: dict = read_json(DATA / "devices.json", {})
        self.activity: list = read_json(DATA / "activity.json", [])
        self.seen: dict = {}

    # ---- paths
    def safe(self, rel: str | None):
        rel = (rel or "").replace("\\", "/")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        for p in parts:
            if p == ".." or ignored(p) or _BAD_CHARS.search(p) or p.endswith((" ", ".")):
                raise ValueError("That name can't be used")
        full = self.root.joinpath(*parts) if parts else self.root
        return full, "/".join(parts)

    # ---- reading
    def _item(self, name: str, rel: str, st, is_dir: bool) -> dict:
        m = self.meta.get(rel, {})
        return {"name": name, "path": rel, "dir": is_dir, "size": 0 if is_dir else st.st_size,
                "mtime": int(st.st_mtime), "by": m.get("by", "")}

    def list(self, rel: str) -> list:
        full, rel = self.safe(rel)
        if not full.is_dir():
            raise FileNotFoundError(rel)
        out = []
        with os.scandir(full) as it:
            for e in it:
                if ignored(e.name):
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                out.append(self._item(e.name, f"{rel}/{e.name}" if rel else e.name, st, e.is_dir()))
        out.sort(key=lambda i: (not i["dir"], i["name"].casefold()))
        return out

    def tree(self) -> dict:
        out = {}
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not ignored(d)]
            rd = Path(dirpath).relative_to(self.root).as_posix()
            prefix = "" if rd == "." else rd + "/"
            for d in dirnames:
                out[prefix + d] = {"d": True}
            for f in filenames:
                if ignored(f):
                    continue
                try:
                    st = os.stat(os.path.join(dirpath, f))
                except OSError:
                    continue
                out[prefix + f] = {"d": False, "s": st.st_size, "m": int(st.st_mtime)}
        return out

    def search(self, q: str) -> list:
        tokens = [t for t in re.split(r"[\s_\-\.]+", q.lower()) if t]
        if not tokens:
            return []
        hits = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not ignored(d)]
            rd = Path(dirpath).relative_to(self.root).as_posix()
            prefix = "" if rd == "." else rd + "/"
            for name, is_dir in [(d, True) for d in dirnames] + [(f, False) for f in filenames]:
                if ignored(name):
                    continue
                rel = prefix + name
                hay_name, hay_path = name.lower(), rel.lower()
                if not all(t in hay_path for t in tokens):
                    continue
                score = sum(3 for t in tokens if t in hay_name) + sum(2 for t in tokens if hay_name.startswith(t))
                score += 2 if is_dir else 0
                try:
                    st = os.stat(self.root / rel)
                except OSError:
                    continue
                hits.append((score, st.st_mtime, self._item(name, rel, st, is_dir)))
        hits.sort(key=lambda h: (-h[0], -h[1]))
        return [h[2] for h in hits[:80]]

    # ---- writing
    def put_file(self, rel: str, stream, length: int, mtime: int | None, who: str) -> None:
        full, rel = self.safe(rel)
        if not rel or full.is_dir():
            raise ValueError("That isn't a file")
        full.parent.mkdir(parents=True, exist_ok=True)
        tmp = full.parent / f".artema-{uuid.uuid4().hex}.part"
        remaining = length
        try:
            with open(tmp, "wb") as f:
                while remaining > 0:
                    chunk = stream.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            if remaining > 0:
                raise ConnectionError("upload interrupted")
            existed = full.exists()
            if existed:
                self._to_trash(full, rel, copy=True)
            os.replace(tmp, full)
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
        if mtime:
            os.utime(full, (mtime, mtime))
        with self.lock:
            self.meta[rel] = {"by": who, "at": now()}
            write_json(DATA / "meta.json", self.meta)
        self.log_event(who, "updated" if existed else "added", rel)

    def _to_trash(self, full: Path, rel: str, copy: bool) -> None:
        dest = self.trash / datetime.now().strftime("%Y-%m-%d_%H-%M-%S") / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        hide(self.trash)
        if copy:
            shutil.copy2(full, dest)
        else:
            shutil.move(str(full), str(dest))

    def delete(self, rel: str, who: str) -> None:
        full, rel = self.safe(rel)
        if not rel:
            raise ValueError("Can't delete the main folder")
        if not full.exists():
            return
        self._to_trash(full, rel, copy=False)
        with self.lock:
            for k in [k for k in self.meta if k == rel or k.startswith(rel + "/")]:
                del self.meta[k]
            write_json(DATA / "meta.json", self.meta)
        self.log_event(who, "deleted", rel)

    def mkdir(self, rel: str, who: str) -> None:
        full, rel = self.safe(rel)
        if not rel:
            raise ValueError("Give the folder a name")
        if full.exists():
            return
        full.mkdir(parents=True)
        self.log_event(who, "created folder", rel)

    def move(self, src: str, dst: str, who: str) -> None:
        a, src = self.safe(src)
        b, dst = self.safe(dst)
        if not src or not dst or not a.exists():
            raise FileNotFoundError(src)
        if b.exists():
            raise FileExistsError(dst)
        b.parent.mkdir(parents=True, exist_ok=True)
        os.replace(a, b)
        with self.lock:
            for k in [k for k in self.meta if k == src or k.startswith(src + "/")]:
                self.meta[dst + k[len(src):]] = self.meta.pop(k)
            write_json(DATA / "meta.json", self.meta)
        self.log_event(who, "renamed", dst)

    # ---- people and history
    def log_event(self, who: str, action: str, rel: str) -> None:
        with self.lock:
            self.activity.append({"t": int(now()), "who": who or "Someone", "action": action, "path": rel})
            del self.activity[:-200]
            write_json(DATA / "activity.json", self.activity)

    def register(self, name: str, ip: str, existing_id: str | None) -> str:
        name = name.strip()
        if not name or len(name) > 40:
            raise ValueError("Pick a name between 1 and 40 characters")
        with self.lock:
            for did, d in self.devices.items():
                if d["name"].casefold() == name.casefold() and did != existing_id:
                    raise FileExistsError("Another computer already uses that name")
            did = existing_id if existing_id in self.devices else uuid.uuid4().hex[:12]
            self.devices[did] = {"name": name, "ip": ip, "added": int(now())}
            write_json(DATA / "devices.json", self.devices)
            self.seen[did] = now()
            return did

    def touch(self, did: str) -> None:
        if did in self.devices:
            self.seen[did] = now()

    def remove_device(self, did: str) -> None:
        with self.lock:
            self.devices.pop(did, None)
            self.seen.pop(did, None)
            write_json(DATA / "devices.json", self.devices)

    def device_list(self) -> list:
        out = [{"id": "host", "name": self.host_name, "online": True, "host": True, "ip": lan_ip()}]
        t = now()
        for did, d in self.devices.items():
            last = self.seen.get(did)
            out.append({"id": did, "name": d["name"], "ip": d.get("ip", ""), "host": False,
                        "online": bool(last and t - last < ONLINE_SECONDS), "last": int(last) if last else None})
        return out


# --------------------------------------------------------------------------- http plumbing

class BaseHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ArtemaPortal/" + VERSION
    default_page = "index.html"

    def log_message(self, *args):
        pass

    def send_bytes(self, code: int, ctype: str, data: bytes, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        if code >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def json(self, obj, code: int = 200) -> None:
        self.send_bytes(code, "application/json; charset=utf-8", json.dumps(obj).encode("utf-8"))

    def body_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ValueError("Request too large")
        raw = self.rfile.read(n) if n else b""
        return json.loads(raw.decode("utf-8")) if raw else {}

    def static(self, path: str) -> None:
        rel = self.default_page if path in ("", "/") else path.lstrip("/")
        full = (WEB / rel).resolve()
        if WEB.resolve() not in full.parents or not full.is_file():
            return self.json({"error": "Not found"}, 404)
        ctype = mimetypes.guess_type(full.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self.send_bytes(200, ctype, full.read_bytes())

    def dispatch(self, method: str) -> None:
        try:
            u = urllib.parse.urlsplit(self.path)
            q = dict(urllib.parse.parse_qsl(u.query))
            self.who = urllib.parse.unquote(self.headers.get("X-Device", "")).strip()[:60] or "Someone"
            self.route(method, u.path, q)
        except FileExistsError as e:
            self.json({"error": str(e) or "That already exists"}, 409)
        except FileNotFoundError:
            self.json({"error": "Not found"}, 404)
        except ValueError as e:
            self.json({"error": str(e)}, 400)
        except (ConnectionError, TimeoutError):
            self.close_connection = True
        except Exception:
            log("handler error: " + traceback.format_exc())
            try:
                self.json({"error": "Something went wrong"}, 500)
            except OSError:
                self.close_connection = True

    def route(self, method, path, q):  # pragma: no cover
        raise NotImplementedError

    def do_GET(self): self.dispatch("GET")
    def do_HEAD(self): self.dispatch("GET")
    def do_POST(self): self.dispatch("POST")
    def do_PUT(self): self.dispatch("PUT")


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
    allow_reuse_address = True


def make_portal_handler(store: Store, port: int):
    class PortalHandler(BaseHandler):
        def local_only(self):
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                raise ValueError("Only available on the main computer")

        def route(self, method, path, q):
            did = self.headers.get("X-Device-Id")
            if did:
                store.touch(did)
            if not path.startswith("/api/"):
                if method == "GET":
                    return self.static(path)
                return self.json({"error": "Not found"}, 404)
            ep = path[5:]

            if method == "GET":
                if ep == "info":
                    return self.json({"app": APP_NAME, "version": VERSION, "name": store.host_name,
                                      "ip": lan_ip(), "port": port, "folder": str(store.root),
                                      "local": self.client_address[0] in ("127.0.0.1", "::1")})
                if ep == "list":
                    return self.json({"path": store.safe(q.get("path"))[1], "items": store.list(q.get("path", ""))})
                if ep == "tree":
                    return self.json({"items": store.tree()})
                if ep == "search":
                    return self.json({"items": store.search(q.get("q", ""))})
                if ep == "devices":
                    return self.json({"devices": store.device_list(), "address": f"{lan_ip()}:{port}"})
                if ep == "activity":
                    return self.json({"items": list(reversed(store.activity[-60:]))})
                if ep == "file":
                    return self.send_file(q)
            elif method == "PUT" and ep == "file":
                full, rel = store.safe(q.get("path"))
                length = int(self.headers.get("Content-Length") or 0)
                mt = int(q["mtime"]) if q.get("mtime", "").isdigit() else None
                store.put_file(rel, self.rfile, length, mt, self.who)
                return self.json({"ok": True})
            elif method == "POST":
                b = self.body_json()
                if ep == "mkdir":
                    store.mkdir(b.get("path", ""), self.who)
                    return self.json({"ok": True})
                if ep == "delete":
                    store.delete(b.get("path", ""), self.who)
                    return self.json({"ok": True})
                if ep == "move":
                    store.move(b.get("from", ""), b.get("to", ""), self.who)
                    return self.json({"ok": True})
                if ep == "register":
                    new_id = store.register(b.get("name", ""), self.client_address[0], b.get("id"))
                    return self.json({"ok": True, "id": new_id})
                if ep == "devices/remove":
                    store.remove_device(b.get("id", ""))
                    return self.json({"ok": True})
                if ep == "reveal":
                    self.local_only()
                    full, rel = store.safe(b.get("path", ""))
                    if full.is_file():
                        subprocess.Popen(["explorer", "/select,", str(full)])
                    elif os.name == "nt":
                        os.startfile(str(full))
                    return self.json({"ok": True})
            self.json({"error": "Not found"}, 404)

        def send_file(self, q):
            full, rel = store.safe(q.get("path"))
            if not full.is_file():
                raise FileNotFoundError(rel)
            ctype = mimetypes.guess_type(full.name)[0] or "application/octet-stream"
            inline = q.get("inline") == "1" and ctype.startswith(("image/", "application/pdf", "text/"))
            size = full.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-cache")
            disp = "inline" if inline else "attachment"
            self.send_header("Content-Disposition", f"{disp}; filename*=UTF-8''{urllib.parse.quote(full.name)}")
            self.end_headers()
            if self.command != "HEAD":
                with open(full, "rb") as f:
                    shutil.copyfileobj(f, self.wfile, 1 << 20)

    return PortalHandler


# --------------------------------------------------------------------------- client sync agent

def _sig(v):
    return tuple(v) if isinstance(v, list) else v


class Agent(threading.Thread):
    """Keeps this computer's Artema Portal folder identical to the main computer's."""

    def __init__(self, cfg: dict):
        super().__init__(daemon=True, name="sync-agent")
        self.cfg = cfg
        self.base_url = cfg["host_url"].rstrip("/")
        self.folder = Path(cfg["folder"])
        self.state_path = DATA / "sync-state.json"
        self.stop_ev = threading.Event()
        self.status = {"state": "starting", "message": "Starting…", "last": None, "files": 0}

    # ---- http
    def headers(self, extra=None) -> dict:
        h = {"X-Device": urllib.parse.quote(self.cfg["name"]), "X-Device-Id": self.cfg.get("device_id", "")}
        h.update(extra or {})
        return h

    def call(self, path: str, body=None, timeout=15):
        data = json.dumps(body).encode() if body is not None else None
        hdr = self.headers({"Content-Type": "application/json"} if body is not None else None)
        req = urllib.request.Request(self.base_url + path, data=data, headers=hdr, method="POST" if body is not None else "GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def download(self, p: str, sig) -> tuple:
        dest = self.folder.joinpath(*p.split("/"))
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / f".artema-{uuid.uuid4().hex}.part"
        req = urllib.request.Request(self.base_url + "/api/file?path=" + urllib.parse.quote(p), headers=self.headers())
        try:
            with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            os.replace(tmp, dest)
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
        os.utime(dest, (sig[1], sig[1]))
        st = os.stat(dest)
        return (st.st_size, int(st.st_mtime))

    def upload(self, p: str, sig) -> None:
        src = self.folder.joinpath(*p.split("/"))
        with open(src, "rb") as f:
            req = urllib.request.Request(
                self.base_url + f"/api/file?path={urllib.parse.quote(p)}&mtime={sig[1]}", data=f,
                headers=self.headers({"Content-Length": str(sig[0]), "Content-Type": "application/octet-stream"}),
                method="PUT")
            urllib.request.urlopen(req, timeout=60).read()

    # ---- local view
    def scan_local(self):
        out, unstable = {}, set()
        t = now()
        for dirpath, dirnames, filenames in os.walk(self.folder):
            dirnames[:] = [d for d in dirnames if not ignored(d)]
            rd = Path(dirpath).relative_to(self.folder).as_posix()
            prefix = "" if rd == "." else rd + "/"
            for d in dirnames:
                out[prefix + d] = "d"
            for f in filenames:
                if ignored(f):
                    continue
                try:
                    st = os.stat(os.path.join(dirpath, f))
                except OSError:
                    continue
                out[prefix + f] = (st.st_size, int(st.st_mtime))
                if t - st.st_mtime < 2:         # still being copied in; leave it alone this round
                    unstable.add(prefix + f)
        return out, unstable

    # ---- the sync itself
    def sync(self, base: dict) -> int:
        if not self.folder.exists():
            self.folder.mkdir(parents=True, exist_ok=True)
            base.clear()                        # folder was removed: restore from the main computer
        tree = self.call("/api/tree")["items"]
        remote = {p: ("d" if v["d"] else (v["s"], v["m"])) for p, v in tree.items()}
        local, unstable = self.scan_local()

        plan = {"mk_up": [], "mk_down": [], "up": [], "down": [], "ldel": [], "rdel": [], "conflict": []}
        for p in set(local) | set(remote) | set(base):
            if p in unstable:
                continue
            L, R, B = local.get(p), remote.get(p), base.get(p)
            if L == R:
                if L is None:
                    base.pop(p, None)
                else:
                    base[p] = L
                continue
            if "d" in (L, R) and L is not None and R is not None:
                continue                         # file vs folder clash: leave it for a human
            if B is None:
                what = "up" if R is None else "down" if L is None else "conflict"
            elif L == B:
                what = "ldel" if R is None else "down"
            elif R == B:
                what = "rdel" if L is None else "up"
            else:
                what = "down" if L is None else "up" if R is None else "conflict"
            if what == "up" and L == "d":
                what = "mk_up"
            if what == "down" and R == "d":
                what = "mk_down"
            plan[what].append(p)

        # Safety net: a sudden wave of deletions is almost always a mistake (wiped folder, drive hiccup).
        known = max(len(base), 1)
        if len(plan["rdel"]) >= 8 and len(plan["rdel"]) > known / 2:
            plan["down"] += plan["rdel"]; plan["rdel"] = []
        if len(plan["ldel"]) >= 8 and len(plan["ldel"]) > known / 2:
            plan["up"] += plan["ldel"]; plan["ldel"] = []

        depth = lambda s: s.count("/")
        errors = 0

        def attempt(fn, *a):
            nonlocal errors
            try:
                fn(*a)
            except Exception as e:
                errors += 1
                log(f"sync error: {e!r}")

        def do_mk_up(p):
            self.call("/api/mkdir", {"path": p}); base[p] = "d"

        def do_mk_down(p):
            self.folder.joinpath(*p.split("/")).mkdir(parents=True, exist_ok=True); base[p] = "d"

        def do_up(p):
            self.upload(p, local[p]); base[p] = local[p]

        def do_down(p):
            base[p] = self.download(p, remote[p])

        def do_conflict(p):
            src = self.folder.joinpath(*p.split("/"))
            stem, suf = src.stem, src.suffix
            n, copy = 1, src.with_name(f"{stem} (conflict {self.cfg['name']}){suf}")
            while copy.exists():
                n += 1
                copy = src.with_name(f"{stem} (conflict {self.cfg['name']} {n}){suf}")
            os.replace(src, copy)
            base[p] = self.download(p, remote[p])

        def do_ldel(p):
            tgt = self.folder.joinpath(*p.split("/"))
            if local[p] == "d":
                tgt.rmdir()
            else:
                tgt.unlink()
            base.pop(p, None)

        def do_rdel(p):
            try:
                self.call("/api/delete", {"path": p})
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
            base.pop(p, None)

        for p in sorted(plan["mk_up"], key=depth): attempt(do_mk_up, p)
        for p in sorted(plan["mk_down"], key=depth): attempt(do_mk_down, p)
        for p in plan["down"]: attempt(do_down, p)
        for p in plan["conflict"]: attempt(do_conflict, p)
        for p in plan["up"]: attempt(do_up, p)
        for p in sorted(plan["ldel"], key=depth, reverse=True): attempt(do_ldel, p)
        for p in sorted(plan["rdel"], key=depth, reverse=True): attempt(do_rdel, p)

        write_json(self.state_path, {"base": base})
        self.status["files"] = sum(1 for v in remote.values() if v != "d")
        return errors

    def run(self):
        raw = read_json(self.state_path, {}).get("base", {})
        base = {p: _sig(v) for p, v in raw.items()}
        while not self.stop_ev.is_set():
            try:
                errs = self.sync(base)
                if errs:
                    self.status.update(state="warn", message=f"{errs} file(s) couldn't sync yet")
                else:
                    self.status.update(state="ok", message="Up to date", last=int(now()))
            except OSError:
                self.status.update(state="offline", message="Can't reach the main computer")
            except Exception:
                log("agent error: " + traceback.format_exc())
                self.status.update(state="warn", message="Something went wrong. Retrying…")
            self.stop_ev.wait(SYNC_SECONDS)


# --------------------------------------------------------------------------- system integration

def startup_dir() -> Path:
    return Path(os.environ.get("APPDATA", str(Path.home()))) / "Microsoft/Windows/Start Menu/Programs/Startup"


def install_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "Programs" / APP_NAME


def install_self() -> Path:
    """Packaged exe: copy ourselves somewhere permanent so Downloads can be cleaned up safely."""
    me = Path(sys.executable).resolve()
    target = install_dir() / me.name
    if target.exists() and me == target.resolve():
        return me                                    # already running from the permanent copy
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(me, target)
        return target
    except OSError as e:
        log(f"couldn't install exe copy: {e!r}")
        return me


def install_startup() -> None:
    if TESTING or os.name != "nt":
        return
    if FROZEN:
        cmd = f'"""{install_self()}"" --background"'
    else:
        exe = Path(sys.executable)
        pyw = exe.with_name("pythonw.exe")
        cmd = f'"""{pyw if pyw.exists() else exe}"" ""{Path(__file__).resolve()}"" --background"'
    vbs = f'Set sh = CreateObject("WScript.Shell")\r\nsh.Run {cmd}, 0, False\r\n'
    d = startup_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / "ArtemaPortal.vbs").write_text(vbs, encoding="utf-16")


def remove_startup() -> None:
    try:
        (startup_dir() / "ArtemaPortal.vbs").unlink()
    except OSError:
        pass


def open_firewall(port: int) -> bool:
    if TESTING or os.name != "nt":
        return True
    try:
        r = subprocess.run(["netsh", "advfirewall", "firewall", "add", "rule", f"name={APP_NAME}", "dir=in",
                            "action=allow", "protocol=TCP", f"localport={port}", "profile=private,domain"],
                           capture_output=True, creationflags=0x08000000, timeout=15)
        return r.returncode == 0
    except Exception:
        return False


def make_shortcut(url: str) -> None:
    if TESTING:
        return
    try:
        (desktop_dir() / f"{APP_NAME}.url").write_text(f"[InternetShortcut]\r\nURL={url}\r\n", encoding="utf-8")
    except OSError:
        pass


def open_in_explorer(path: Path) -> None:
    if os.name == "nt":
        os.startfile(str(path))


# --------------------------------------------------------------------------- app: wizard + lifecycle

class App:
    def __init__(self):
        self.cfg: dict = read_json(DATA / "config.json", {})
        self.store: Store | None = None
        self.server: QuietServer | None = None
        self.agent: Agent | None = None
        self.start_error = ""

    # ---- derived
    @property
    def configured(self) -> bool:
        return self.cfg.get("role") in ("host", "client")

    def portal_url(self) -> str:
        if self.cfg.get("role") == "host":
            return f"http://localhost:{self.cfg['port']}/"
        if self.cfg.get("role") == "client":
            return self.cfg["host_url"].rstrip("/") + "/?as=" + urllib.parse.quote(self.cfg["name"])
        return ""

    # ---- lifecycle
    def start_role(self) -> None:
        self.start_error = ""
        role = self.cfg.get("role")
        try:
            if role == "host":
                self.store = Store(Path(self.cfg["folder"]), self.cfg["name"])
                port = int(self.cfg["port"])
                self.server = QuietServer(("0.0.0.0", port), make_portal_handler(self.store, port))
                threading.Thread(target=self.server.serve_forever, daemon=True, name="portal").start()
            elif role == "client":
                self.agent = Agent(self.cfg)
                self.agent.start()
        except OSError as e:
            self.start_error = "That port is already in use. Try another one." if role == "host" else str(e)
            log(f"start failed: {e!r}")

    def stop_role(self) -> None:
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.agent:
            self.agent.stop_ev.set()
        self.server = self.agent = self.store = None

    def save_cfg(self, cfg: dict) -> None:
        self.cfg = cfg
        write_json(DATA / "config.json", cfg)

    # ---- wizard actions
    def state(self) -> dict:
        s = {"configured": self.configured, "role": self.cfg.get("role"), "name": self.cfg.get("name", ""),
             "hostname": socket.gethostname(), "default_port": DEFAULT_PORT, "lan_ip": lan_ip(),
             "folder": self.cfg.get("folder", str(desktop_dir() / APP_NAME)), "portal_url": self.portal_url(),
             "error": self.start_error, "version": VERSION}
        if self.cfg.get("role") == "host":
            s["port"] = self.cfg.get("port")
            s["address"] = f"{lan_ip()}:{self.cfg.get('port')}"
            s["devices"] = len(self.store.devices) if self.store else 0
            s["status"] = {"state": "ok" if self.server else "warn", "message": "Serving files" if self.server else "Not running"}
        elif self.cfg.get("role") == "client":
            s["host_url"] = self.cfg.get("host_url")
            s["status"] = self.agent.status if self.agent else {"state": "warn", "message": "Not running", "files": 0}
        return s

    def probe(self, addr: str):
        addr = norm_addr(addr)
        try:
            with urllib.request.urlopen(f"http://{addr}/api/info", timeout=3) as r:
                info = json.loads(r.read().decode("utf-8"))
            if info.get("app") != APP_NAME:
                return None
            return {"address": addr, "name": info.get("name", addr)}
        except (OSError, ValueError):
            return None

    def scan(self, port: int) -> list:
        ip = lan_ip()
        if ip.startswith("127."):
            return []
        prefix = ip.rsplit(".", 1)[0]

        def check(i):
            addr = f"{prefix}.{i}"
            try:
                with socket.create_connection((addr, port), timeout=0.4):
                    pass
            except OSError:
                return None
            return self.probe(f"{addr}:{port}")

        with ThreadPoolExecutor(64) as ex:
            return [r for r in ex.map(check, range(1, 255)) if r]

    def setup_host(self, name: str, port: int) -> dict:
        name = (name or "").strip()
        if not name or len(name) > 40:
            raise ValueError("Give this computer a name")
        if not 1024 <= port <= 65535:
            raise ValueError("Pick a port between 1024 and 65535")
        self.stop_role()
        self.save_cfg({"role": "host", "name": name, "port": port, "folder": str(desktop_dir() / APP_NAME)})
        self.start_role()
        if self.start_error:
            err = self.start_error
            self.cfg = {}
            (DATA / "config.json").unlink(missing_ok=True)
            raise ValueError(err)
        fw = open_firewall(port)
        install_startup()
        make_shortcut(self.portal_url())
        return {"ok": True, "address": f"{lan_ip()}:{port}", "firewall": fw, "portal_url": self.portal_url()}

    def join(self, addr: str, name: str) -> dict:
        name = (name or "").strip()
        if not name or len(name) > 40:
            raise ValueError("Give this computer a name")
        host = self.probe(addr)
        if not host:
            raise ValueError("Couldn't find the main computer at that address")
        url = f"http://{host['address']}"
        old_id = self.cfg.get("device_id") if self.cfg.get("host_url") == url else None
        req = urllib.request.Request(url + "/api/register", method="POST", headers={"Content-Type": "application/json"},
                                     data=json.dumps({"name": name, "id": old_id}).encode())
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                device_id = json.loads(r.read().decode("utf-8"))["id"]
        except urllib.error.HTTPError as e:
            if e.code == 409:
                raise ValueError("Another computer already uses that name. Pick a different one.")
            raise ValueError("The main computer refused the connection")
        self.stop_role()
        self.save_cfg({"role": "client", "name": name, "host_url": url, "device_id": device_id,
                       "folder": str(desktop_dir() / APP_NAME)})
        self.start_role()
        install_startup()
        make_shortcut(self.portal_url())
        return {"ok": True, "host": host["name"], "portal_url": self.portal_url()}

    def reset(self) -> None:
        self.stop_role()
        self.cfg = {}
        (DATA / "config.json").unlink(missing_ok=True)
        remove_startup()


def make_local_handler(app: App):
    class LocalHandler(BaseHandler):
        default_page = "wizard.html"

        def route(self, method, path, q):
            if not path.startswith("/api/"):
                return self.static(path) if method == "GET" else self.json({"error": "Not found"}, 404)
            ep = path[5:]
            if method == "GET" and ep == "state":
                return self.json(app.state())
            if method == "POST":
                b = self.body_json()
                if ep == "probe":
                    found = app.probe(b.get("address", ""))
                    return self.json({"ok": bool(found), **(found or {})})
                if ep == "scan":
                    return self.json({"found": app.scan(int(b.get("port") or DEFAULT_PORT))})
                if ep == "host":
                    return self.json(app.setup_host(b.get("name", ""), int(b.get("port") or DEFAULT_PORT)))
                if ep == "join":
                    return self.json(app.join(b.get("address", ""), b.get("name", "")))
                if ep == "reset":
                    app.reset()
                    return self.json({"ok": True})
                if ep == "open-folder":
                    open_in_explorer(Path(app.cfg.get("folder", "")))
                    return self.json({"ok": True})
            self.json({"error": "Not found"}, 404)

    return LocalHandler


def open_browser(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception:
        pass


def main() -> None:
    background = "--background" in sys.argv
    local_url = f"http://127.0.0.1:{LOCAL_PORT}/"
    app = App()
    try:
        local = QuietServer(("127.0.0.1", LOCAL_PORT), make_local_handler(app))
    except OSError:
        # Already running: just bring up the right page.
        if not background:
            try:
                with urllib.request.urlopen(local_url + "api/state", timeout=3) as r:
                    st = json.loads(r.read().decode("utf-8"))
                open_browser(st.get("portal_url") or local_url)
            except (OSError, ValueError):
                open_browser(local_url)
        return

    app.start_role()
    if not background:
        open_browser(app.portal_url() if app.configured and not app.start_error else local_url)
    log(f"started v{VERSION} role={app.cfg.get('role')} data={DATA}")
    try:
        local.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
