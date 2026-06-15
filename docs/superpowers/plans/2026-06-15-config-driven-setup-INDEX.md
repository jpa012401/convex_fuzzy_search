# Config-Driven Setup + ID Results — Plan Index

Spec: [`../specs/2026-06-15-config-driven-setup-and-id-results-design.md`](../specs/2026-06-15-config-driven-setup-and-id-results-design.md)

Four independently-shippable plans. Each produces working, tested software.

## Recommended execution order

```
P2 (index-relevant projection)   ─┐
P3 (config object + sync)        ─┤  independent; do in any order
P1 (search returns ids)          ─┘  (P3 reads cleaner with P2's "derived")
                │
                ▼
P4 (reindex replay)   requires P3 (pendingFields) AND P1 (productDocs table)
```

- **P2** — [p2-index-relevant-projection](2026-06-15-p2-index-relevant-projection.md): store only role-union fields; `storedFields: "derived"`.
- **P3** — [p3-config-object-sync](2026-06-15-p3-config-object-sync.md): declarative config + `client.sync()`; your original ask.
- **P1** — [p1-search-returns-ids](2026-06-15-p1-search-returns-ids.md): `search` returns `{id, score, highlight}`; example hydrates by id (adds app-owned `productDocs`).
- **P4** — [p4-reindex-replay](2026-06-15-p4-reindex-replay.md): app-driven reindex for structural additions; depends on P3 + P1.

Rationale: P3 first delivers the "setup like aggregate" feel with lowest risk (client layer, doesn't touch the search engine). P1 is most invasive (every search return path) so it's isolated. P4 closes the loop once both prerequisites land.
