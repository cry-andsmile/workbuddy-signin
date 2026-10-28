# -*- coding: utf-8 -*-
"""
从本机 Qoder 客户端 auth.v1.dat (Chromium v10 + DPAPI) 解出 API token，
备份旧文件 -> 更新本地 qoder_token.txt -> 推送到服务器。

用法:
    python refresh_qoder_from_local.py            # 只解 token + 推送
    python refresh_qoder_from_local.py --claim    # 解 token + 推送 + 立刻领取今日

前提: 本机 Qoder 客户端已登录（auth.v1.dat 会被客户端定期刷新）。
"""
import os
import sys
import json
import base64
import ctypes
import shutil
import datetime
import ctypes.wintypes as wt

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
QD_DATA = os.path.join(os.environ.get("APPDATA", ""), "com.qoder.app.stable")
AUTH_DAT = os.path.join(QD_DATA, "auth.v1.dat")
LOCAL_STATE = os.path.join(QD_DATA, "Local State")
TOKEN_FILE = os.path.join(BASE_DIR, "qoder_token.txt")

# 服务器（与项目其它部署脚本一致）：凭据只从 .env / 环境变量读取
from envconf import load_local_env
load_local_env()
SFTP_HOST = os.environ.get("ECS_HOST", "")
SFTP_PORT = int(os.environ.get("ECS_PORT", "22") or 22)
SFTP_USER = os.environ.get("ECS_USER", "root")
SFTP_PW = os.environ.get("ECS_PASS", "")
REMOTE_TOKEN = "/opt/wb-checkin/qoder_token.txt"


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def dpapi_decrypt(data):
    """Windows DPAPI 解密（当前用户上下文）"""
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out))
    if not ok:
        raise OSError("CryptUnprotectData failed: %d" % ctypes.GetLastError())
    out = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return out


def extract():
    """解出 (token, 解析后的 dict)"""
    if not os.path.exists(AUTH_DAT):
        raise FileNotFoundError("找不到 %s（请确认本机 Qoder 客户端已登录并运行过）" % AUTH_DAT)
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    ls = json.load(open(LOCAL_STATE, encoding="utf-8"))
    enc_key = base64.b64decode(ls["os_crypt"]["encrypted_key"])
    aes_key = dpapi_decrypt(enc_key[5:])  # 去掉 'DPAPI' 前缀
    raw = open(AUTH_DAT, "rb").read()
    if raw[:3] != b"v10":
        raise ValueError("auth.v1.dat 不是 Chromium v10 格式: %r" % raw[:3])
    plain = AESGCM(aes_key).decrypt(raw[3:15], raw[15:], None)
    d = json.loads(plain.decode("utf-8"))
    tok = (d.get("token") or "").strip()
    if not tok.startswith("dt-"):
        raise ValueError("解出的 token 不是 dt- 开头: %r" % tok[:12])
    return tok, d


def push_server(tok):
    if not SFTP_HOST or not SFTP_PW:
        raise RuntimeError("缺少 ECS_HOST / ECS_PASS，请在 %s/.env 里填写" % BASE_DIR)
    import paramiko
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(SFTP_HOST, SFTP_PORT, SFTP_USER, SFTP_PW,
              look_for_keys=False, allow_agent=False, timeout=25)
    s = c.open_sftp()
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        s.rename(REMOTE_TOKEN, REMOTE_TOKEN + ".old_" + ts)
    except Exception:
        pass
    s.open(REMOTE_TOKEN, "wb").write(tok.encode())
    s.close()
    c.close()


def main():
    do_claim = "--claim" in sys.argv
    tok, d = extract()
    exp = d.get("expiresAt") or "?"
    exp_rt = d.get("refreshTokenExpiresAt") or "?"
    user = (d.get("user") or {})
    print("[Qoder] 解出 token: %s...  (len=%d)" % (tok[:12], len(tok)))
    print("[Qoder] expiresAt=%s  refreshExpiresAt=%s" % (exp, exp_rt))

    if os.path.exists(TOKEN_FILE):
        bak = TOKEN_FILE + ".bak_" + datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        shutil.copy2(TOKEN_FILE, bak)
        print("[Qoder] 已备份本地旧 token ->", os.path.basename(bak))
    open(TOKEN_FILE, "w", encoding="utf-8").write(tok)
    print("[Qoder] 已写入", TOKEN_FILE)

    try:
        push_server(tok)
        print("[Qoder] 已推送服务器 /opt/wb-checkin/qoder_token.txt")
    except Exception as e:
        print("[Qoder] ⚠️ 推送服务器失败:", e)

    if do_claim:
        print("[Qoder] === 立刻领取今日 ===")
        import subprocess
        keeper = os.path.join(BASE_DIR, "qoder_keeper", "qoder_keeper.py")
        subprocess.call([sys.executable, keeper, "run"])

    print("[Qoder] 完成 ✅")


if __name__ == "__main__":
    main()
