# -*- coding: utf-8 -*-
"""Link AI 滑块验证码自动求解器（AJ-Captcha blockPuzzle）

## 原理

Link AI 的签到验证码是开源的 AJ-Captcha，滑块模式。它的接口设计存在两个可利用点：

1. `/api/captcha/get` 与 `/api/captcha/check` **完全无鉴权**，不需要 Authorization。
2. 服务端把【完整原图】(originalImageBase64) 和【缺口小块】(jigsawImageBase64)
   同时下发给客户端。小块带 alpha 通道，是原图上抠出来的。
   → 于是可以用「alpha 掩膜 + 逐列像素差」反推出缺口在原图中的真实 x 坐标。

3. 签名算法是硬编码密钥的 AES/ECB/PKCS7：
      pointJson          = AES(secretKey,  '{"x":<拖动距离>,"y":5}')
      captchaVerification= AES(secretKey,  token + '---' + '{"x":..,"y":..}')

## 实测（2026-10-16）

连续 5 轮识别 + 提交，全部 repCode=0000：
    识别 x=112 差异20.58 | x=124 差异24.51 | x=141 差异30.64
    | x=128 差异42.79 | x=264 差异13.55      →  成功率 5/5

最优解与次优解差异呈断层（如 22.96 vs 39.50），说明信号非常干净，
不是凑巧撞对的噪声。

## 边界

本模块只解决「人机验证」这一环，产出 captchaVerification。
签到本身仍需一个有效的登录 token（`Authorization: Bearer <jwt>`），
因为 /sign/in 是强鉴权接口。
"""
import base64
import json
import urllib.error
import urllib.request
from io import BytesIO

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from PIL import Image
import numpy as np

CAPTCHA_KEY = "XwKsGlMcdPMEhR1B"      # 前端硬编码，见 app.js 的 x() 函数
BASE = "https://link-ai.tech"

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def _aes_encrypt(plain, key=CAPTCHA_KEY):
    """等价于前端 CryptoJS: AES.encrypt(utf8(plain), utf8(key),
    {mode: ECB, padding: Pkcs7}).toString()"""
    cipher = AES.new(key.encode(), AES.MODE_ECB)
    return base64.b64encode(cipher.encrypt(pad(plain.encode(), 16))).decode()


def _post(path, body, token=None, timeout=20):
    headers = {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": _UA,
        "Origin": BASE,
        "Referer": BASE + "/console/account",
    }
    if token:
        headers["Authorization"] = "Bearer %s" % token
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 method="POST", headers=headers)
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def _find_gap_x(bg_bytes, jig_bytes):
    """定位缺口横向距离。

    返回 (x, score)。x 是「拖动距离」，即缺口左边缘在背景图中的列号；
    score 是模板与背景在该位置的平均像素差（越小越可信）。
    """
    bg = np.array(Image.open(BytesIO(bg_bytes)).convert("RGB")).astype(np.float64)
    ja = np.array(Image.open(BytesIO(jig_bytes)).convert("RGBA"))

    alpha = ja[:, :, 3]
    ys, xs = np.nonzero(alpha > 128)
    if len(xs) == 0:
        raise RuntimeError("拼图块 alpha 通道为空，无法提取形状")

    top, left = int(ys.min()), int(xs.min())
    h = int(ys.max()) - top + 1
    w = int(xs.max()) - left + 1

    sub = ja[top:top + h, left:left + w]
    solid = sub[:, :, 3] > 200                  # 只用实心像素参与比对
    if solid.sum() < 50:
        raise RuntimeError("拼图块实心像素过少（%d），无法可靠匹配" % solid.sum())
    tmpl = sub[:, :, :3].astype(np.float64)

    band = bg[top:top + h, :, :]
    best_x, best_score = None, None
    # 缺口不会贴在左边缘，从 1/4 宽度起扫，既省算力又避免误判
    for x in range(max(1, w // 2), bg.shape[1] - w + 1):
        diff = np.abs(band[:, x:x + w, :] - tmpl).mean(axis=2)
        score = float(diff[solid].mean())
        if best_score is None or score < best_score:
            best_x, best_score = x, score
    if best_x is None:
        raise RuntimeError("未找到任何匹配位置")
    return best_x, best_score


def solve_captcha(max_retry=5):
    """完整走一遍滑块验证，返回 captchaVerification 字符串。

    失败会重试（每轮都是全新的验证码），max_retry 次后抛异常。
    """
    last = None
    for attempt in range(1, max_retry + 1):
        st, j = _post("/api/captcha/get", {"captchaType": "blockPuzzle"})
        if j.get("repCode") != "0000":
            last = "获取验证码失败 repCode=%s" % j.get("repCode")
            continue

        d = j["repData"]
        secret = d["secretKey"]
        token = d["token"]
        bg = base64.b64decode(d["originalImageBase64"])
        jig = base64.b64decode(d["jigsawImageBase64"])

        x, score = _find_gap_x(bg, jig)
        point_json = json.dumps({"x": x, "y": 5}, separators=(",", ":"))
        st, res = _post("/api/captcha/check", {
            "captchaType": "blockPuzzle",
            "pointJson": _aes_encrypt(point_json, secret),
            "token": token,
        })
        if res.get("repCode") == "0000":
            return _aes_encrypt("%s---%s" % (token, point_json), secret)
        last = "第 %d 轮校验未通过（识别 x=%d 差异=%.2f）repCode=%s %s" % (
            attempt, x, score, res.get("repCode"), res.get("repMsg") or "")
    raise RuntimeError("滑块验证连续 %d 次失败：%s" % (max_retry, last))


if __name__ == "__main__":
    print("连续求解 5 次，检验稳定性：")
    ok = 0
    for i in range(1, 6):
        try:
            sig = solve_captcha()
            print("  %d) 成功  %s..." % (i, sig[:60]))
            ok += 1
        except Exception as e:
            print("  %d) 失败  %s: %s" % (i, type(e).__name__, e))
    print("成功率 %d/5" % ok)
