# Model and assumptions

The engine (`sim/engine.js`) advances the terminal one minute at a time. Everything random comes from one seeded generator (mulberry32), so a seed is a reproducible week.

## Terminal

| Resource | Model |
|---|---|
| Quay | 2 berths (Q1, Q2); 2 quay cranes per vessel, 1 at Q1 when *crane down* is on |
| Crane cycle | 2–3.2 min per move, plus 2 min per rehandle when loading |
| Yard | 6 blocks × 10 bays × 6 rows × 4 tiers = 1,440 slots. A–C import, D–E export, R reefer (plugs). Dry boxes overflow into any dry block |
| Gate | 4 lanes, 2–4 min document check per truck |
| Yard equipment | 8 straddle carriers for gate jobs, 5–8 min per job plus 3 min per rehandle |

## Flows

- **Vessels**: 11 calls, 2–12 h apart, 70–140 boxes to discharge and to load each. A BAPLIE arrives 6 h before ETA. A vessel berths first-come-first-served, discharges, loads everything of its booking that is in the yard, and sails at least an hour after berthing.
- **Exports**: each booking (COPARN) gets a truck appointment between 72 h before ETA and the 4 h cut-off. Most hauliers drive by day: 75% of night slots move into the next working day. 2% never show and are rolled.
- **Imports**: each discharged box gets a pickup appointment after 0.4–2.8 days (85%) or 3–6 days (the long tail). 12% get a customs hold of 4–30 h; a truck that comes during the hold is refused at the gate and rebooked.

## Yard strategies

| | Random | Smart |
|---|---|---|
| Export placement | any free stack in the export blocks | a stack holding only the same vessel and port of discharge, else an empty stack |
| Import placement | any free stack in the import blocks | the lowest stack |
| Loading sequence | stowage-plan order | the box with the fewest containers on top first |
| Rehandle target | random stack in the same block | the lowest stack in the same block |

## What is deliberately left out

20/40-foot slot geometry, weight classes and stowage stability, crane interference, shift changes, rail and barge, reefer power limits, hazardous segregation, real customs and port-community-system integration. These are the next things a real TOS has to get right; the model stays small enough to read in one sitting.

## KPIs

| KPI | Definition |
|---|---|
| Yard utilisation | occupied slots / 1,440 |
| Crane productivity | quay moves / crane-hours while alongside (gross) |
| Rehandles per 100 retrievals | unproductive moves per 100 boxes taken out of the yard |
| Truck turnaround | gate arrival → gate exit, refused trucks excluded |
| Vessel turnaround | arrival at pilot station → departure |
