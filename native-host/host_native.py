"""
Host Switcher용 Chrome Native Messaging 호스트.

Chrome 확장(common.js의 applyHostsFile)이 chrome.runtime.sendNativeMessage로 보내는
요청을 받아 hosts 파일의 마커 블록을 통째로 재작성한다. 확장이 매번 새 프로세스를
실행/종료하므로(요청 1건당 프로세스 1개), 여기서는 상태를 들고 있지 않고 매 호출마다
hosts 파일을 처음부터 읽고 다시 쓴다.

Native Messaging 프로토콜: stdin/stdout에 4바이트 리틀엔디안 길이 + UTF-8 JSON 메시지.
Windows에서는 반드시 stdin/stdout을 binary 모드로 열어야 한다 (텍스트 모드면 개행이
CRLF로 변환되어 길이 프리픽스가 깨진다).
"""

import json
import os
import re
import struct
import sys
import time

DEBUG_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug.log")


def _dbg(msg):
    try:
        with open(DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} pid={os.getpid()} {msg}\n")
    except Exception:
        pass


HOSTS_PATH = r"C:\Windows\System32\drivers\etc\hosts"
MARK_START = "# === HOST_SWITCHER START (자동 생성, 직접 편집 금지) ==="
MARK_END = "# === HOST_SWITCHER END ==="

HOSTNAME_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,62}\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,62})?$")
IPV4_RE = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")


def is_valid_hostname(value):
    return isinstance(value, str) and 1 <= len(value) <= 253 and bool(HOSTNAME_RE.match(value))


def is_valid_ipv4(value):
    m = IPV4_RE.match(value or "")
    if not m:
        return False
    return all(0 <= int(part) <= 255 for part in m.groups())


def read_message():
    _dbg("read_message: start, waiting for 4-byte length prefix")
    raw_len = sys.stdin.buffer.read(4)
    _dbg(f"read_message: got length prefix bytes={raw_len!r}")
    if len(raw_len) < 4:
        return None
    (msg_len,) = struct.unpack("<I", raw_len)
    _dbg(f"read_message: msg_len={msg_len}, reading body")
    raw_msg = sys.stdin.buffer.read(msg_len)
    _dbg(f"read_message: got body len={len(raw_msg)} raw={raw_msg[:200]!r}")
    return json.loads(raw_msg.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def build_block(entries):
    lines = [MARK_START]
    for entry in entries:
        lines.append(f"{entry['ip']} {entry['domain']}")
    lines.append(MARK_END)
    return "\n".join(lines)


def apply_entries(entries):
    _dbg(f"apply_entries: start, entries={entries}")
    cleaned = []
    for entry in entries:
        domain = entry.get("domain")
        ip = entry.get("ip")
        if not is_valid_hostname(domain) or not is_valid_ipv4(ip):
            return {"ok": False, "error": f"잘못된 도메인/IP 값: {entry}"}
        cleaned.append({"domain": domain, "ip": ip})

    _dbg("apply_entries: opening hosts file for read")
    try:
        with open(HOSTS_PATH, "r", encoding="utf-8", errors="ignore") as f:
            original = f.read()
    except OSError as e:
        _dbg(f"apply_entries: read failed: {e}")
        return {"ok": False, "error": f"hosts 파일을 읽을 수 없습니다: {e}"}
    _dbg(f"apply_entries: read {len(original)} chars")

    block = build_block(cleaned)
    pattern = re.compile(
        re.escape(MARK_START) + r".*?" + re.escape(MARK_END),
        re.DOTALL,
    )

    if pattern.search(original):
        updated = pattern.sub(block, original)
    else:
        sep = "" if original.endswith("\n") or original == "" else "\n"
        updated = original + sep + "\n" + block + "\n"
    _dbg("apply_entries: computed updated content, writing hosts file")

    # install.ps1은 hosts 파일 "자체"에만 쓰기 권한을 부여하고, 담고 있는 폴더
    # (System32\drivers\etc)에는 권한을 주지 않는다. 임시 파일을 만들어 os.replace()로
    # 교체하는 방식은 폴더 안에 새 디렉터리 엔트리를 만드는 것과 같아서 폴더 단위 권한이
    # 추가로 필요해 실패한다(파일에 새 이름을 만드는 게 아니라 진짜 새 파일을 만드는
    # 것과 동일하게 취급됨). 대신 이미 존재하는 hosts 파일을 그 자리에서 바로 열어
    # 내용만 덮어쓴다 — 이건 파일 자체의 쓰기 권한만 있으면 되고, 폴더 권한은 필요 없다.
    try:
        with open(HOSTS_PATH, "w", encoding="utf-8", newline="\n") as f:
            f.write(updated)
        _dbg("apply_entries: wrote hosts file in place")
    except OSError as e:
        _dbg(f"apply_entries: write failed: {e}")
        return {
            "ok": False,
            "error": f"hosts 파일에 쓸 권한이 없습니다. install.ps1로 권한을 부여했는지 확인하세요: {e}",
        }

    _dbg("apply_entries: success")
    return {"ok": True}


def main():
    _dbg("main: process started")
    message = read_message()
    _dbg(f"main: message={message}")
    if message is None:
        _dbg("main: no message, exiting")
        return

    action = message.get("action")
    if action == "ping":
        send_message({"ok": True, "pong": True})
        _dbg("main: ping response sent")
    elif action == "apply":
        result = apply_entries(message.get("entries") or [])
        send_message(result)
        _dbg(f"main: apply response sent: {result}")
    else:
        send_message({"ok": False, "error": f"알 수 없는 action: {action}"})
        _dbg("main: unknown-action response sent")
    _dbg("main: about to return from main()")


if __name__ == "__main__":
    main()
    _dbg("script: main() returned, process should exit now")
