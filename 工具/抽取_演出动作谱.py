#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抽取 Live2D 演出层(_command===21) 的 情绪→演出动作 映射。
按上游 model 名(_targetName) 归并，多形态角色天然分列(mutsumi / mortis)。
输出 _演出动作谱.json，供 角色模型/设计思路/ §2 说法层 作为真源证据引用。
"""
import json, os, glob
from collections import defaultdict, Counter

BASE = r"D:/Project/bangdream-our-notes-canon"
CACHE = os.path.join(BASE, ".cache", "script", "ja")
OUT_JSON = os.path.join(BASE, "角色模型", "设计思路", "_演出动作谱.json")

files = sorted(glob.glob(os.path.join(CACHE, "*-Episode.json")))
print(f"scan {len(files)} episode files ...")

by_model = defaultdict(lambda: {
    "total": 0,
    "expressions": Counter(),
    "motions": Counter(),
    "exp_motion": defaultdict(Counter),   # exp -> {motion: count}
})

n_cmd21 = 0
n_valid = 0
empty_target = 0

for fp in files:
    try:
        with open(fp, encoding="utf-8") as f:
            d = json.load(f)
    except Exception as ex:
        print("ERR", fp, ex); continue
    arr = d.get("_allData", d) if isinstance(d, dict) else d
    if not isinstance(arr, list):
        continue
    for it in arr:
        if not isinstance(it, dict):
            continue
        if it.get("_command") != 21:
            continue
        n_cmd21 += 1
        t = (it.get("_targetName") or "").strip()
        m = (it.get("_motionName") or "").strip()
        e = (it.get("_expressionName") or "").strip()
        # 源数据脏点：个别行 _expressionName 误填成动作名(mtn_*) → 视为无表情
        if e.startswith("mtn_"):
            e = ""
        if not t:
            empty_target += 1
            continue
        if not m and not e:
            # 纯镜头/BGM 指令，无表演内容
            continue
        n_valid += 1
        rec = by_model[t]
        rec["total"] += 1
        if e:
            rec["expressions"][e] += 1
            if m:
                rec["exp_motion"][e][m] += 1
        if m:
            rec["motions"][m] += 1

# 序列化
out = {
    "_meta": {
        "source": ".cache/script/ja/*-Episode.json  (Live2D 演出层 _command===21)",
        "files_scanned": len(files),
        "command21_total": n_cmd21,
        "valid_performance_lines": n_valid,
        "empty_target_skipped": empty_target,
        "rule": "按上游 model 名(_targetName) 归并，不按叙事身份；多形态角色分列(mutsumi/mortis 等)",
        "note": "这是 §2 说法层的【真源证据】(可回溯到 advId)，不是生成式手稿。语义判断仍需人工写。",
    },
    "byModel": {},
}

for t in sorted(by_model):
    rec = by_model[t]
    exp_motion = {e: dict(cnt) for e, cnt in rec["exp_motion"].items()}
    out["byModel"][t] = {
        "total": rec["total"],
        "expressions": dict(rec["expressions"].most_common()),
        "motions": dict(rec["motions"].most_common()),
        "expMotion": exp_motion,
    }

with open(OUT_JSON, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

print(f"valid lines={n_valid}  models={len(by_model)}")
print("models:", ", ".join(sorted(by_model)))
