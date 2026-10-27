# System flow

```text
Carrier            Terminal (Noordkaai TOS)                                       Haulier
───────            ───────────────────────────────────────────────────            ───────
COPARN  ─────────▶ booking registered ──▶ truck appointment planned
                                                   │
                                                   ▼
                                           gate-in (CODECO) ◀──────────────────── truck arrives
                                                   │
                                                   ▼
                                           yard allocation (strategy) ──▶ stack in export block
BAPLIE  ─────────▶ vessel announced (−6 h)
                   vessel arrives ──▶ waits for berth ──▶ alongside, cranes start
                   discharge ──▶ yard allocation ──▶ stack in import block ──▶ pickup planned
                   load ──▶ retrieve (rehandles) ──▶ vessel
COARRI  ◀───────── vessel sails: discharge/load report
                                           pickup: customs hold? ── yes ──▶ refused, rebooked
                                                   │ no
                                                   ▼
                                           retrieve (rehandles) ──▶ gate-out (CODECO) ─────▶ truck leaves
                                                   │
                                                   ▼
                                           MOVE_EVENT (CSV) ──▶ warehouse / BI
```
