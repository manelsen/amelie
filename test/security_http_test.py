"""Testes HTTP locais. Executar após gleam build: python3 test/security_http_test.py."""

import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class WebhookSecurityTest(unittest.TestCase):
    token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    telegram_secret = "synthetic-telegram-webhook-secret"

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="amelie-http-security-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.media = cls.root / "media"
        cls.media.mkdir(mode=0o700)
        repo = Path(__file__).resolve().parents[1]
        shutil.copytree(repo / "config", cls.root / "config")
        # Executa os módulos compilados num cwd isolado, sem carregar o .env do usuário.
        ebin_dirs = [str(path) for path in sorted(repo.glob("build/dev/erlang/*/ebin"))]
        if not ebin_dirs:
            raise RuntimeError("Execute gleam build antes deste teste")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{port}"
        env = dict(os.environ, BRIDGE_TOKEN=cls.token, PORT=str(port),
                   DB_PATH=str(cls.root / "test.sqlite"), MEDIA_TEMP_DIR=str(cls.media),
                   GEMINI_API_KEY="", OPENROUTER_API_KEY="", TELEGRAM_BOT_TOKEN="",
                   TELEGRAM_ADMIN_CHAT_ID="", TELEGRAM_SECRET_TOKEN=cls.telegram_secret,
                   WHATSMEOW_URL="http://127.0.0.1:0")
        cls.log = open(cls.root / "server.log", "w+")
        cls.addClassCleanup(cls.log.close)
        cls.server = subprocess.Popen(
            ["erl", "-noshell", "-pa", *ebin_dirs, "-eval", "'amelie@@main':run(amelie)."],
            cwd=cls.root, env=env,
            stdout=cls.log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        cls.addClassCleanup(cls.stop_server)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if cls.server.poll() is not None:
                break
            try:
                if cls.call("/health", method="GET")[0] == 200:
                    return
            except (URLError, TimeoutError):
                time.sleep(0.1)
        cls.log.seek(0)
        raise RuntimeError("Servidor local não iniciou:\n" + cls.log.read())

    @classmethod
    def stop_server(cls):
        if cls.server.poll() is None:
            os.killpg(cls.server.pid, signal.SIGTERM)
            try:
                cls.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(cls.server.pid, signal.SIGKILL)
                cls.server.wait()

    @classmethod
    def call(cls, path, payload=None, headers=None, method="POST"):
        data = None if payload is None else json.dumps(payload).encode()
        req = Request(cls.base + path, data=data, method=method,
                      headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urlopen(req, timeout=2) as response:
                return response.status, response.read()
        except HTTPError as error:
            return error.code, error.read()

    def bridge_headers(self):
        return {"X-Amelie-Bridge-Token": self.token}

    def payload(self, **overrides):
        # Grupo sem menção: o core não chama IA nem envia resposta.
        return {"chat_id": "123@g.us",
            "from": "456@s.whatsapp.net", "ts": int(time.time()), "em_grupo": True,
            "menciona_bot": False, "tipo": "texto", "text": "test", **overrides,
        }

    def test_all_webhooks_require_correct_secret(self):
        for path in ("/webhook", "/webhook/bridge-event", "/webhook/telegram"):
            for headers in ({}, {"X-Amelie-Bridge-Token": "wrong", "X-Telegram-Bot-Api-Secret-Token": "wrong"}):
                with self.subTest(path=path, headers=headers):
                    self.assertEqual(401, self.call(path, {}, headers)[0])

    def test_authenticated_requests_require_post(self):
        for path in ("/webhook", "/webhook/bridge-event"):
            self.assertEqual(405, self.call(path, headers=self.bridge_headers(), method="GET")[0])

    def test_legitimate_bridge_and_telegram_envelopes_are_accepted(self):
        self.assertEqual(202, self.call("/webhook", self.payload(), self.bridge_headers())[0])
        self.assertEqual(200, self.call("/webhook/bridge-event", {"evento": "whatsapp_down"}, self.bridge_headers())[0])
        self.assertEqual(200, self.call("/webhook/telegram", {"update_id": 1},
            {"X-Telegram-Bot-Api-Secret-Token": self.telegram_secret})[0])

    def test_bridge_cannot_impersonate_telegram_admin(self):
        data = self.payload(**{"from": "tg:123", "text": ".reset_whatsapp"})
        self.assertEqual(400, self.call("/webhook", data, self.bridge_headers())[0])

    def test_external_paths_and_symlinks_are_rejected_before_processing(self):
        outside = self.root / "private.txt"
        outside.write_text("do not read or delete")
        link = self.media / "amelie_midia_link"
        link.symlink_to(outside)
        for path in (outside, link, self.media / ".." / "private.txt"):
            for kind in ("audio", "video"):
                with self.subTest(path=path, kind=kind):
                    data = self.payload(tipo=kind, caminho_temp=str(path), mime="audio/ogg")
                    self.assertEqual(400, self.call("/webhook", data, self.bridge_headers())[0])
                    self.assertEqual("do not read or delete", outside.read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
