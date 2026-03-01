# server/tools.py
from __future__ import annotations

from pathlib import Path

from contracts import InventorySearchArgs, InventorySearchResult
from inventory.service import InventoryService
from inventory.providers.file_provider import FileInventoryProvider
from inventory.load_fake_json import load_fake_inventory_json

# ---- load fake data ----
DATA_PATH = Path(__file__).parent / "data" / "fake_inventory.json"
_FAKE_ROWS = load_fake_inventory_json(DATA_PATH)

_provider = FileInventoryProvider(_FAKE_ROWS)
_service = InventoryService(_provider, cache_ttl_s=30)


def inventory_search(args: InventorySearchArgs) -> InventorySearchResult:
    return _service.search(args)
