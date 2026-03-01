from __future__ import annotations

import time

from contracts import (
    InventorySearchArgs,
    InventorySearchResult,
    ItemLocation,
    Promotion,
)


class FileInventoryProvider:
    name = "file.v1"

    def __init__(self, data_rows: list[dict]):
        # data_rows: normalized rows already parsed from CSV/XLSX/DOCX/JSON
        self.rows = data_rows

    def search(self, args: InventorySearchArgs) -> InventorySearchResult:
        q = (args.query or "").strip().lower()
        mode = args.mode

        # simple match (production: add synonyms/fuzzy)
        def row_match(r: dict) -> bool:
            hay = " ".join([
                str(r.get("item_name", "")),
                str(r.get("brand", "")),
                str(r.get("category", "")),
                str(r.get("model", "")),
                str(r.get("sku", "")),
            ]).lower()
            return q in hay

        matches = [r for r in self.rows if row_match(r)]

        # promotions: pick any promotion fields in matched rows
        promos = []
        for r in matches:
            p = (r.get("promotion") or "").strip()
            if p:
                promos.append(Promotion(title=p))

        # category mode: return aisle only (choose most common aisle among matches)
        if mode == "category":
            if not matches:
                return InventorySearchResult(
                    found=False,
                    mode=mode,
                    query=args.query,
                    meta={"provider": self.name, "ts": time.time()},
                )
            aisle = matches[0].get("aisle") or ""
            return InventorySearchResult(
                found=True,
                mode=mode,
                query=args.query,
                category_aisle=aisle,
                promotions=promos[:1],
                meta={"provider": self.name, "ts": time.time(), "matched": len(matches)},
            )

        # item mode: return detailed locations
        items = []
        for r in matches[:20]:
            items.append(ItemLocation(
                item_name=r.get("item_name") or args.query,
                brand=r.get("brand"),
                model=r.get("model"),
                sku=r.get("sku"),
                aisle=r.get("aisle") or "",
                bay=r.get("bay"),
                on_hand=r.get("on_hand"),
                price=r.get("price"),
            ))

        return InventorySearchResult(
            found=bool(items),
            mode=mode,
            query=args.query,
            items=items,
            promotions=promos[:1],
            meta={"provider": self.name, "ts": time.time(), "matched": len(matches)},
        )
