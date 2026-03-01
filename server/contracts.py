# server/contracts.py
from __future__ import annotations

from typing import List, Optional, Literal, Dict, Any

from pydantic import BaseModel, Field

InventoryMode = Literal["item", "category"]


class InventorySearchArgs(BaseModel):
    mode: InventoryMode
    query: str
    store_id: Optional[str] = None


class Promotion(BaseModel):
    title: str
    detail: Optional[str] = None


class ItemLocation(BaseModel):
    item_name: str
    brand: Optional[str] = None
    model: Optional[str] = None
    sku: Optional[str] = None
    aisle: str
    bay: Optional[str] = None
    on_hand: Optional[int] = None
    price: Optional[float] = None


class InventorySearchResult(BaseModel):
    found: bool
    mode: InventoryMode
    query: str
    category_aisle: Optional[str] = None
    items: List[ItemLocation] = Field(default_factory=list)
    promotions: List[Promotion] = Field(default_factory=list)
    meta: Dict[str, Any] = Field(default_factory=dict)
    schema_version: str = "invsearch.v1"
