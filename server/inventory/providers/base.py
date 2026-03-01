from __future__ import annotations

from abc import ABC, abstractmethod

from contracts import InventorySearchArgs, InventorySearchResult


class InventoryProvider(ABC):
    name: str

    @abstractmethod
    def search(self, args: InventorySearchArgs) -> InventorySearchResult:
        """Return InventorySearchResult (must conform to contract)."""
        raise NotImplementedError
