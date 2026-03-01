from __future__ import annotations

import time
from typing import Optional

import httpx

from contracts import InventorySearchArgs, InventorySearchResult


class HttpInventoryProvider:
    name = "http.v1"

    def __init__(self, base_url: str, api_key: Optional[str] = None, timeout_s: float = 4.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_s = timeout_s

    def search(self, args: InventorySearchArgs) -> InventorySearchResult:
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        payload = args.model_dump()
        t0 = time.time()
        try:
            with httpx.Client(timeout=self.timeout_s) as client:
                resp = client.post(f"{self.base_url}/inventory/search", json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            return InventorySearchResult(
                found=False,
                mode=args.mode,
                query=args.query,
                meta={
                    "provider": self.name,
                    "error": str(e),
                    "ts": time.time(),
                    "lat_ms": int((time.time() - t0) * 1000),
                },
            )

        # hard validate contract
        out = InventorySearchResult.model_validate(data)
        out.meta = {
            **(out.meta or {}),
            "provider": self.name,
            "ts": time.time(),
            "lat_ms": int((time.time() - t0) * 1000),
        }
        return out
