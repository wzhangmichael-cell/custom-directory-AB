from __future__ import annotations

import time
from typing import Dict, Tuple

from contracts import InventorySearchArgs, InventorySearchResult


class InventoryService:
    def __init__(self, provider, cache_ttl_s: int = 30):
        self.provider = provider
        self.cache_ttl_s = cache_ttl_s
        self._cache: Dict[str, Tuple[float, InventorySearchResult]] = {}

    def _key(self, args: InventorySearchArgs) -> str:
        return f"{args.mode}|{(args.query or '').strip().lower()}"

    def search(self, args: InventorySearchArgs) -> InventorySearchResult:
        key = self._key(args)
        now = time.time()

        if self.cache_ttl_s > 0 and key in self._cache:
            ts, val = self._cache[key]
            if now - ts <= self.cache_ttl_s:
                return val

        result = self.provider.search(args)
        # validate again (contract guard)
        result = InventorySearchResult.model_validate(result)

        if self.cache_ttl_s > 0:
            self._cache[key] = (now, result)

        return result
