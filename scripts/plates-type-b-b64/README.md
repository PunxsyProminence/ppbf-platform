# Type B plate b64 sidecars (Grok producer, 2026-08-24)

Exact base64 of the six Type B wall plates. **Do not re-encode.**

```bash
node scripts/materialize-type-b-plates.mjs
```

Writes real 4:4:4 JPEGs to `apps/web/public/plates/` with SOI/EOI checks.

Owner decision 2026-08-24: Grok owns these binaries on its feature branch. Claude is not the courier.
