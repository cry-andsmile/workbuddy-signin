# -*- coding: utf-8 -*-
"""Qoder API Token 一键更新工具（30 天有效期，过期后必用）

用法：
    python refresh_qoder_token.py <新的 dt- 开头 token>
    python refresh_qoder_token.py            # 交互式粘贴

流程：
    1) 校验 token 以 dt- 开头
    2) 备份旧 qoder_token.txt（根目录 + qoder_keeper/ 两处）
    3) 写入新 token（附带 30 天后过期注释 # expiresAt=）
    4) 立刻跑 qoder_keeper run：用新 token + 本机指纹领取今日 100 Credits 并推送服务器
    5) 报告结果

依赖：本机已安装 Qoder 客户端（提供 runtime-info.exe 出设备指纹）。
"""
import sys
import os
import json
import shutil
import datetime
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
TOKEN_PATHS = [
    os.path.join(ROOT, "qoder_token.txt"),
    os.path.join(ROOT, "qoder_keeper", "qoder_token.txt"),
]


def read_old():
    for p in TOKEN_PATHS:
        if os.path.exists(p):
            return p, open(p, "r", encoding="utf-8").read()
    return None, ""


def main():
    tok = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
    if not tok:
        try:
            tok = input("粘贴新的 Qoder API Token (dt- 开头): ").strip()
        except Exception:
            pass
    if not tok:
        print("✗ 未提供 token")
        return 2
    if not tok.startswith("dt-"):
        print("✗ token 应以 dt- 开头（这是 Qoder 后台生成的 API/Access Token，不是网页登录 cookie）")
        return 2

    old_path, old = read_old()
    # 备份
    for p in TOKEN_PATHS:
        if os.path.exists(p):
            try:
                shutil.copy(p, p + ".bak")
            except Exception as e:
                print("[warn] 备份 %s 失败: %r" % (p, e))

    exp = (datetime.datetime.utcnow() + datetime.timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    content = "# expiresAt=%s\n%s\n" % (exp, tok)
    for p in TOKEN_PATHS:
        d = os.path.dirname(p)
        if d and not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
    print("[ok] 已写入新 token 到 %d 个位置 (expiresAt=%s)" % (len(TOKEN_PATHS), exp))

    # 立刻领取今日 + 推送服务器
    keeper = os.path.join(ROOT, "qoder_keeper", "qoder_keeper.py")
    print("[run] 调用 qoder_keeper run 领取今日 Credits ...")
    env = dict(os.environ)
    # 若本机走代理访问 openapi.qoder.sh，可在此注入；默认用系统/Clash 设置
    r = subprocess.run([sys.executable, keeper, "run"], cwd=ROOT, env=env)
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
