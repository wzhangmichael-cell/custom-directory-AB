# server/inventory/load_fake_json.py
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, List, Dict, Optional, Union

CANON_KEYS = {
    "item_name", "brand", "category", "model", "aisle", "bay",
    "on_hand", "price", "promotion", "sku"
}

ALIASES = {
    "name": "item_name",
    "item": "item_name",
    "product_name": "item_name",
    "qty": "on_hand",
    "quantity": "on_hand",
    "stock": "on_hand",
    "location_aisle": "aisle",
    "location_bay": "bay",
}


def _to_int(v: Any) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except Exception:
        return None


def _to_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except Exception:
        return None


def normalize_row(raw: Dict[str, Any]) -> Dict[str, Any]:
    # 1) apply aliases
    r: Dict[str, Any] = {}
    for k, v in raw.items():
        kk = ALIASES.get(k, k)
        r[kk] = v

    # 2) keep only canonical fields (but allow extras later if you want)
    out: Dict[str, Any] = {}
    for k in CANON_KEYS:
        if k in r:
            out[k] = r[k]

    # 3) type normalize
    if "on_hand" in out:
        out["on_hand"] = _to_int(out.get("on_hand"))
    if "price" in out:
        out["price"] = _to_float(out.get("price"))

    # 4) string normalize
    for k in ["item_name", "brand", "category", "model", "aisle", "bay", "promotion", "sku"]:
        if k in out and out[k] is not None:
            out[k] = str(out[k]).strip()

    return out


def load_fake_inventory_json(path: Union[str, Path]) -> List[Dict[str, Any]]:
    p = Path(path)
    data = json.loads(p.read_text(encoding="utf-8"))

    if isinstance(data, dict) and "rows" in data:
        rows = data["rows"]
    else:
        rows = data

    if not isinstance(rows, list):
        raise ValueError("fake_inventory.json must be a list or an object with 'rows' list")

    normalized: List[Dict[str, Any]] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        normalized.append(normalize_row(raw))

    return normalized
