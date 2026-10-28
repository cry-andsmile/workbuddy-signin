# -*- coding: utf-8 -*-
"""凭据体检 + 一键换新 + 只推凭据文件到 112（不动 web_server.py）。

背景
----
签到中心的 Link AI / Qoder / MiniMax Code 三个平台凭据都是「重新登录换 token」型：
没有 refresh_token，服务端无法自行续期，token 只能从本机浏览器登录态里取。
历史坑：deploy_ui.py 会把本地凭据原样覆盖服务器，跑之前要先 cat 回服务器版本同步。

本脚本做的事（子命令）
--------------------
  check                      体检：解析本地三个凭据文件 + 实打接口验活，只读，无副作用
  pull                       把服务器上三个凭据文件下载到本地备份目录（push 前必跑）
  push --linkai=X --qoder="Y Z" --minimax=Z
                             逐个实测校验 → 写本地文件 → SFTP 推服务器 → 重启 wb-checkin
                             --minimax 传新 access_token；--qoder 传 token，可用
                             --qoder-exp 覆盖 expiresAt 注释（默认 +30 天）
  status                     看服务器上三个凭据文件的当前内容摘要

用法示例
--------
  python refresh_creds.py check
  python refresh_creds.py pull
  python refresh_creds.py push --linkai="eyJhbGciOi..."
  python refresh_creds.py push --qoder="dt-xxxx"
  python refresh_creds.py push --minimax="eyJhbGciOi..."

退出码：0 成功；1 有校验失败项；2 参数/环境缺失
"""
import argparse
import datetime
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlencode

BASE = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = os.path.join(BASE, "cred_backup")
REMOTE_DIR = "/opt/wb-checkin"

FILES = {
    "linkai": "linkai_token.txt",
    "qoder": "qoder_token.txt",
    "minimax": "mm_web_token.json",
}

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def load_dotenv():
    path = os.path.join(BASE, ".env")
    if not os.path.isfile(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


load_dotenv()

_SSL = ssl.create_default_context()
_SSL.check_hostname = False
_SSL.verify_mode = ssl.CERT_NONE
_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=_SSL))


def log(msg):
    print("[%s] %s" % (datetime.datetime.now().strftime("%H:%M:%S"), msg))


# ---------------------------------------------------------------- 读取/解析

def read_local(key):
    p = os.path.join(BASE, FILES[key])
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""


def jwt_exp(token):
    import base64
    try:
        seg = token.split(".")[1]
        seg += "=" * (-len(seg) % 4)
        d = json.loads(base64.urlsafe_b64decode(seg.encode("ascii")).decode("utf-8"))
        return d.get("exp")
    except Exception:
        return None


def parse_qoder_expiry(raw):
    import re
    m = re.search(r"expiresAt\s*=\s*([^\s#]+)", raw or "")
    if not m:
        return None
    s = m.group(1).strip().replace("Z", "+00:00").replace("T", " ")
    try:
        d = datetime.datetime.fromisoformat(s)
        if d.tzinfo is not None:
            d = d.replace(tzinfo=None)
        return d.timestamp()
    except Exception:
        return None


def tokens_of():
    """返回 {key: token}，只做提取，不判断有效期。"""
    out = {}
    raw = read_local("linkai").strip()
    out["linkai"] = raw.splitlines()[0].strip() if raw else ""
    raw = read_local("qoder")
    for line in (raw.splitlines() if raw else []):
        line = line.strip()
        if line and not line.startswith("#"):
            out["qoder"] = line
            break
    else:
        out["qoder"] = ""
    try:
        out["minimax"] = (json.loads(read_local("minimax")) or {}).get("access_token", "")
    except Exception:
        out["minimax"] = ""
    return out


# ---------------------------------------------------------------- 实测验活

def _hit(url, headers):
    req = urllib.request.Request(url, headers=headers)
    try:
        with _OPENER.open(req, timeout=25) as f:
            return f.status, f.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return -1, repr(e)


def probe_linkai(tok):
    if not tok:
        return "缺少 token"
    st, body = _hit(
        "https://link-ai.tech/api/chat/web/app/user/sign/in",
        {"User-Agent": UA, "Referer": "https://link-ai.tech/console/account",
         "Accept": "application/json", "Authorization": "Bearer " + tok})
    if st == 200:
        try:
            d = json.loads(body)
        except Exception:
            return "HTTP 200（响应非 JSON，疑似被拦）"
        if d.get("success"):
            return "HTTP 200 签到成功"
        if d.get("code") == 834 or "已签到" in (d.get("message") or ""):
            return "HTTP 200 今日已签"
        return "HTTP 200 code=%s %s" % (d.get("code"), d.get("message"))
    return "HTTP %s %s" % (st, body[:160])


def probe_qoder(tok):
    if not tok:
        return "缺少 token"
    st, body = _hit(
        "https://openapi.qoder.sh/sash/api/v1/me/campaigns",
        {"User-Agent": "Qoder", "Authorization": "Bearer " + tok,
         "Cosy-ClientType": "10", "Cosy-Version": "0.4.1", "Accept": "application/json"})
    if st == 200:
        try:
            cs = (json.loads(body).get("campaigns") or [])
        except Exception:
            cs = []
        claimable = [c for c in cs if c.get("claimStatus") == "CLAIMABLE"]
        return "HTTP 200 活动 %d 项，可领 %d 项" % (len(cs), len(claimable))
    return "HTTP %s %s" % (st, body[:160])


def probe_minimax(tok):
    if not tok:
        return "缺少 token"
    now_ms = int(time.time() * 1000)
    now_s = now_ms // 1000
    params = {
        "device_platform": "web", "biz_id": "3", "app_id": "3001",
        "version_code": "22201", "unix": str(now_ms), "timezone_offset": "28800",
        "sys_language": "zh", "lang": "zh",
        "uuid": "9f344780-29b5-4a7b-985c-9db6957960d0", "device_id": "81828527",
        "os_name": "Windows", "browser_name": "Chrome", "device_memory": "32",
        "cpu_core_num": "20", "browser_language": "zh-CN", "browser_platform": "Win32",
        "user_id": "555802743632904195", "screen_width": "1707", "screen_height": "1067",
        "token": tok, "client": "web", "region": "cn",
    }
    sig = hashlib.md5(("%dI*7Cf%%WZ#S&%%1RlZJ&C2%s" % (now_s, "")).encode("utf-8")).hexdigest()
    url = "https://agent.minimax.cn/minimax-cloud/api/v1/signin/status?" + urlencode(params)
    st, body = _hit(url, {"User-Agent": UA, "Accept": "application/json",
                           "x-timestamp": str(now_s), "x-signature": sig})
    if st == 200:
        try:
            d = json.loads(body)
            days = ((d.get("data") or {}).get("days") or [])
            today = [x for x in days if x.get("is_today")]
            if today:
                t = today[0]
                return "HTTP 200 今日 status=%s points=%s" % (t.get("status"), t.get("points"))
            return "HTTP 200 正常"
        except Exception:
            return "HTTP 200（解析失败）"
    return "HTTP %s %s" % (st, body[:160])


PROBE = {"linkai": probe_linkai, "qoder": probe_qoder, "minimax": probe_minimax}


# ---------------------------------------------------------------- 摘要/体检

def summarize(key):
    raw = read_local(key)
    if not raw.strip():
        return "%-8s 本地文件缺失或为空 (%s)" % (key, FILES[key])
    tok = tokens_of()[key]
    if key in ("linkai", "minimax"):
        exp = jwt_exp(tok)
    else:
        exp = parse_qoder_expiry(raw)
    if exp:
        dt = datetime.datetime.fromtimestamp(float(exp))
        days = (float(exp) - time.time()) / 86400.0
        left = "已过期 %.1f 天" % (-days) if days < 0 else "剩 %.1f 天" % days
        return "%-8s len=%-4d 到期=%s %s" % (key, len(tok), dt.strftime("%Y-%m-%d %H:%M"), left)
    return "%-8s len=%-4d 有效期未知" % (key, len(tok))


def cmd_check(args):
    toks = tokens_of()
    log("== 本地凭据 ==")
    for k in FILES:
        log(summarize(k))
    log("")
    log("== 实打接口验活 ==")
    for k in ("linkai", "qoder", "minimax"):
        log("%-8s %s" % (k, PROBE[k](toks[k])))
    return 0


# ---------------------------------------------------------------- SSH

def ssh_connect():
    import paramiko
    host = os.environ.get("ECS_HOST", "")
    pwd = os.environ.get("ECS_PASS", "")
    if not host or not pwd:
        log("缺少 ECS_HOST / ECS_PASS，请在 %s/.env 里填写" % BASE)
        return None
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=int(os.environ.get("ECS_PORT", "22") or 22),
              username=os.environ.get("ECS_USER", "root"), password=pwd,
              look_for_keys=False, allow_agent=False, timeout=25)
    return c


def cmd_pull(args):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    c = ssh_connect()
    if not c:
        return 2
    sftp = c.open_sftp()
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    for k, fn in FILES.items():
        rp = REMOTE_DIR + "/" + fn
        lp = os.path.join(BACKUP_DIR, "%s.%s" % (fn, ts))
        try:
            sftp.get(rp, lp)
            log("已备份 %-18s -> %s" % (rp, lp))
        except Exception as e:
            log("跳过 %-18s (%s)" % (rp, e))
    sftp.close()
    c.close()
    return 0


def cmd_status(args):
    c = ssh_connect()
    if not c:
        return 2
    for k, fn in FILES.items():
        _, out, err = c.exec_command(
            "stat -c '%%s bytes  %%y' %s/%s" % (REMOTE_DIR, fn), timeout=20)
        info = (out.read().decode() + err.read().decode()).strip()
        log("%-18s %s" % (fn, info or "（无输出）"))
    c.close()
    return 0


# ---------------------------------------------------------------- 写入+推送

def write_local(key, value, extra=None):
    p = os.path.join(BASE, FILES[key])
    if key == "linkai":
        content = value.strip() + "\n"
    elif key == "qoder":
        exp_at = (extra or {}).get("qoder_exp")
        if not exp_at:
            exp_at = (datetime.datetime.now() + datetime.timedelta(days=30)).strftime(
                "%Y-%m-%dT%H:%M:%SZ")
        content = "%s\n# expiresAt=%s\n" % (value.strip(), exp_at)
    else:  # minimax
        try:
            d = json.loads(read_local("minimax")) or {}
        except Exception:
            d = {}
        d["access_token"] = value.strip()
        d.setdefault("web_auth", True)
        d["updated_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        content = json.dumps(d, ensure_ascii=False, indent=2) + "\n"
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)
    log("已写本地 %s (%d 字节)" % (FILES[key], len(content.encode("utf-8"))))
    return p


def cmd_push(args):
    given = {k: getattr(args, k, None) for k in ("linkai", "qoder", "minimax")}
    given = {k: v for k, v in given.items() if v}
    if not given:
        log("没给任何 token。用 --linkai= / --qoder= / --minimax= 至少给一个")
        return 2

    # 1) 先体检服务器现状 + 备份
    log("[1/4] 备份服务器上的凭据")
    cmd_pull(args)

    # 2) 逐个实测校验，不合格的不写
    ok_list = []
    for k, v in given.items():
        log("[2/4] 校验 %s 新 token ..." % k)
        res = PROBE[k](v.strip())
        log("       %s" % res)
        if res.startswith("HTTP 200"):
            ok_list.append((k, v))
        else:
            log("       !! %s 校验不通过，跳过（不写不推）" % k)
    if not ok_list:
        log("没有任何 token 通过校验，中止")
        return 1

    # 3) 写本地 + 推服务器
    log("[3/4] 写入本地并推送")
    c = ssh_connect()
    if not c:
        return 2
    sftp = c.open_sftp()
    for k, v in ok_list:
        write_local(k, v, {"qoder_exp": args.qoder_exp})
        rp = REMOTE_DIR + "/" + FILES[k]
        sftp.put(os.path.join(BASE, FILES[k]), rp)
        sftp.chmod(rp, 0o600)
        _, out, err = c.exec_command("md5sum %s" % rp, timeout=20)
        log("       推送 %s -> %s  %s" % (FILES[k], rp, out.read().decode().strip()
                                         or err.read().decode().strip()))
    sftp.close()

    # 4) 重启（MM_WEB_TOKEN 等在模块加载时缓存，换完必须重启才生效）
    log("[4/4] 重启 wb-checkin")
    _, out, err = c.exec_command(
        "systemctl restart wb-checkin && sleep 4 && systemctl is-active wb-checkin",
        timeout=60)
    out_s = out.read().decode().strip()
    err_s = err.read().decode().strip()
    log("       %s %s" % (out_s, err_s))
    c.close()
    if "active" not in out_s:
        log("服务未 active，请上服务器 journalctl -u wb-checkin -n 50 查")
        return 1
    log("")
    log("完成。到 https://bjzjsf.asia/checkin/ 点「重新检查」看卡片变绿")
    return 0


def main():
    ap = argparse.ArgumentParser(description="签到中心凭据体检与更换")
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("check", help="体检本地三个凭据 + 实打接口验活")
    sub.add_parser("pull", help="下载服务器上的凭据做本地备份")
    sub.add_parser("status", help="看服务器上凭据文件的时间/大小")

    p = sub.add_parser("push", help="换新 token 并推送到服务器")
    p.add_argument("--linkai", help="Link AI 的 Bearer token（不含 Bearer 前缀）")
    p.add_argument("--qoder", help="Qoder token")
    p.add_argument("--minimax", help="MiniMax Code 网页 access_token")
    p.add_argument("--qoder-exp", help="Qoder 的 expiresAt（ISO，默认 +30 天）")

    args = ap.parse_args()
    fn = {"check": cmd_check, "pull": cmd_pull, "status": cmd_status, "push": cmd_push}
    if args.cmd not in fn:
        ap.print_help()
        return 2
    return fn[args.cmd](args)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main())