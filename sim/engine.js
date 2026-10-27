// Terminal simulation engine. Pure and deterministic: the same config and seed
// always give the same terminal, minute by minute. No DOM in this file.

import { codeco, coparn, baplie, coarri } from "./edi.js";

export const START = Date.UTC(2026, 10, 2, 6, 0); // Monday 2 Nov 2026, 06:00 (sim clock is UTC-free "terminal time")
export const ROWS = 6;
export const BAYS = 10;
export const TIERS = 4;
export const BLOCKS = [
  { id: "A", use: "import" },
  { id: "B", use: "import" },
  { id: "C", use: "import" },
  { id: "D", use: "export" },
  { id: "E", use: "export" },
  { id: "R", use: "reefer" },
];
export const BERTHS = ["Q1", "Q2"];
export const LANES = 4;
export const YARD_EQUIPMENT = 8;
export const CRANES_PER_VESSEL = 2;

const OWNERS = ["NKTU", "HBLU", "TDWU", "CRLU", "VRDU", "OSTU"];
const PODS = ["GBTIL", "GBIMM", "IEDUB", "NOOSL", "SEGOT", "ESBIO"];
const VESSELS = ["Nordic Tern", "Saline Star", "Kestrel Bay", "Amber Coast", "Grey Heron", "Polar Wren", "Dune Runner", "Sea Lark", "Iron Gannet", "Silt Harbour", "North Plover"];

/* ---------- helpers ---------- */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ISO 6346 check digit for an 10-character prefix like "CSQU305438". */
export function checkDigit(prefix) {
  const letterValue = (ch) => {
    let v = 10;
    for (let c = 65; c < ch.charCodeAt(0); c++) {
      v++;
      if (v % 11 === 0) v++;
    }
    return v;
  };
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = prefix[i];
    const v = /[A-Z]/.test(ch) ? letterValue(ch) : Number(ch);
    sum += v * 2 ** i;
  }
  return (sum % 11) % 10;
}

export const stackKey = (block, bay, row) => `${block}${String(bay).padStart(2, "0")}-${row}`;
export const parseStack = (key) => ({ block: key[0], bay: Number(key.slice(1, 3)), row: Number(key.slice(4)) });

export function clockLabel(t) {
  const d = new Date(START + t * 60000);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return `${day} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/* ---------- setup ---------- */

export const DEFAULT_CONFIG = {
  seed: 42,
  strategy: "smart", // "smart" | "random"
  lanesOpen: LANES, // close lanes to see the queue build (2 = half the gate down)
  customsHoldPct: 0.12,
  craneDown: false, // one crane at Q1 out of service
};

export function createTerminal(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const rng = mulberry32(cfg.seed);
  const s = {
    t: 0,
    cfg,
    rng,
    seq: 1,
    containers: new Map(),
    yard: new Map(),
    vessels: [],
    berths: BERTHS.map((id) => ({ id, vessel: null })),
    gate: { queue: [], lanes: Array(LANES).fill(null), yardQueue: [], equipmentBusy: [] },
    truckPlan: new Map(), // minute -> [{ kind, container }]
    edi: [],
    events: [],
    moves: [], // every physical container move, for BI export
    k: {
      quayMoves: 0,
      craneMinutes: 0,
      rehandles: 0,
      retrievals: 0,
      trucksIn: 0,
      trucksOut: 0,
      tatSum: 0,
      rejected: 0,
      rolled: 0,
      vesselsDone: 0,
      turnaroundSum: 0,
      berthWaitSum: 0,
      dwellSum: 0,
      dwellCount: 0,
      maxQueue: 0,
    },
  };

  for (const b of BLOCKS) for (let bay = 1; bay <= BAYS; bay++) for (let row = 1; row <= ROWS; row++) s.yard.set(stackKey(b.id, bay, row), []);

  // Vessel schedule: eleven calls, 2 to 12 hours apart, so berths sometimes get busy.
  let eta = 2 * 60;
  for (let i = 0; i < VESSELS.length; i++) {
    const v = {
      id: `V${String(i + 1).padStart(2, "0")}`,
      name: VESSELS[i],
      voyage: `${26}${String(40 + i).padStart(2, "0")}N`,
      eta,
      ata: null,
      atb: null,
      atd: null,
      status: "expected",
      berth: null,
      discharge: [],
      load: [],
      discharged: 0,
      loaded: 0,
      cranes: [],
      announced: false,
    };
    const nDis = 70 + Math.floor(rng() * 70);
    const nLoad = 70 + Math.floor(rng() * 70);
    for (let j = 0; j < nDis; j++) v.discharge.push(newContainer(s, { category: "import", vessel: v.id, status: "onVessel" }).id);
    for (let j = 0; j < nLoad; j++) {
      const c = newContainer(s, { category: "export", vessel: v.id, status: "booked" });
      // Export boxes may arrive from 72 h before the call until a 4 h cut-off.
      c.windowOpen = eta - 72 * 60;
      c.cutoff = eta - 4 * 60;
      v.load.push(c.id);
      s.edi.push(coparn(s, c, v));
      // About 2% of booked boxes never show up before the cut-off.
      if (rng() > 0.02 && c.cutoff > 30) {
        const from = Math.max(0, c.windowOpen);
        const at = daytime(s, from + Math.floor(rng() * Math.max(1, c.cutoff - 60 - from)));
        planTruck(s, Math.min(at, c.cutoff - 30), "drop", c); // never after the cut-off
      }
    }
    s.vessels.push(v);
    eta += 2 * 60 + Math.floor(rng() * 10 * 60);
  }

  // The yard is not empty on Monday morning: imports from earlier calls, exports already gated in.
  for (let j = 0; j < 330; j++) {
    const c = newContainer(s, { category: "import", vessel: "V00", status: "inYard" });
    c.dischargedAt = -Math.floor(rng() * 72 * 60);
    if (rng() < cfg.customsHoldPct) c.holdUntil = Math.floor(rng() * 24 * 60);
    place(s, c, false);
    planPickup(s, c);
  }
  for (const v of s.vessels.slice(0, 2)) {
    // Boxes for a call whose cut-off has already passed are (nearly) all in; later calls are still filling.
    for (const id of v.load) {
      const c = s.containers.get(id);
      // Calls closing within six hours are (nearly) complete; the next ones are half in.
      if ((c.cutoff <= 6 * 60 && s.rng() < 0.98) || s.rng() < 0.5) {
        c.status = "inYard";
        c.gatedInAt = -Math.floor(s.rng() * 24 * 60);
        place(s, c, false);
        dropPlanned(s, c);
      }
    }
  }
  log(s, "info", `Terminal opened. ${s.vessels.length} vessel calls planned, ${s.containers.size} containers known.`);
  return s;
}

function newContainer(s, { category, vessel, status }) {
  const rng = s.rng;
  let id;
  do {
    const prefix = OWNERS[Math.floor(rng() * OWNERS.length)] + String(100000 + Math.floor(rng() * 899999));
    id = prefix + checkDigit(prefix);
  } while (s.containers.has(id)); // container numbers are unique on a terminal
  const reefer = rng() < 0.12;
  const c = {
    id,
    category,
    type: reefer ? "45R1" : rng() < 0.55 ? "45G1" : "22G1",
    reefer,
    weight: Math.round(8 + rng() * 22),
    pod: category === "export" ? PODS[Math.floor(rng() * PODS.length)] : "BEZEE",
    vessel,
    status,
    loc: null,
    holdUntil: null,
    history: [],
  };
  s.containers.set(id, c);
  return c;
}

/* ---------- truck appointments ---------- */

/** Most hauliers drive by day: a slot at night usually moves into the next working day. */
function daytime(s, t) {
  const hour = (Math.floor(t / 60) + 6) % 24;
  if ((hour >= 22 || hour < 6) && s.rng() < 0.75) {
    const toSix = ((24 - hour + 6) % 24) * 60 - (t % 60);
    return t + toSix + Math.floor(s.rng() * 14 * 60); // somewhere in the next working day
  }
  return t;
}

function planTruck(s, t, kind, c) {
  const list = s.truckPlan.get(t) ?? [];
  list.push({ kind, container: c.id });
  s.truckPlan.set(t, list);
  c.plannedAt = t;
}

function dropPlanned(s, c) {
  for (const [t, list] of s.truckPlan) {
    const i = list.findIndex((j) => j.container === c.id);
    if (i >= 0) list.splice(i, 1);
  }
}

/** Import dwell: most boxes leave within 1–4 days, a long tail stays a week. */
function planPickup(s, c) {
  const days = s.rng() < 0.85 ? 0.4 + s.rng() * 2.4 : 3 + s.rng() * 3;
  // A box that is already overdue gets a slot somewhere in the next half day, not all at once.
  const at = Math.max(s.t + 30 + Math.floor(s.rng() * 12 * 60), c.dischargedAt + Math.round(days * 1440));
  planTruck(s, daytime(s, at), "pickup", c);
}

/* ---------- yard ---------- */

function candidateStacks(s, c) {
  const blocks = c.reefer ? ["R"] : c.category === "import" ? ["A", "B", "C"] : ["D", "E"];
  const keys = [];
  for (const [key, stack] of s.yard) if (blocks.includes(key[0]) && stack.length < TIERS) keys.push(key);
  if (keys.length || c.reefer) return keys; // reefers need a plug: no overflow
  // Overflow: any dry block with space.
  for (const [key, stack] of s.yard) if (key[0] !== "R" && stack.length < TIERS) keys.push(key);
  return keys;
}

/** Choose a stack for a container. This is where the two strategies differ. */
export function chooseStack(s, c) {
  const keys = candidateStacks(s, c);
  if (!keys.length) return null;
  if (s.cfg.strategy === "random") return keys[Math.floor(s.rng() * keys.length)];

  if (c.category === "export") {
    // Keep each vessel and port of discharge together, so loading digs less.
    const same = keys.filter((k) => {
      const st = s.yard.get(k);
      return st.length > 0 && st.every((id) => {
        const o = s.containers.get(id);
        return o.vessel === c.vessel && o.pod === c.pod;
      });
    });
    if (same.length) return same.sort((a, b) => s.yard.get(b).length - s.yard.get(a).length)[0];
    const empty = keys.filter((k) => s.yard.get(k).length === 0);
    if (empty.length) return empty[0];
  }
  // Imports leave in unknown order: keep stacks low.
  let best = keys[0];
  for (const k of keys) if (s.yard.get(k).length < s.yard.get(best).length) best = k;
  return best;
}

function place(s, c, record = true, from = "") {
  const key = chooseStack(s, c);
  if (!key) return false;
  const st = s.yard.get(key);
  st.push(c.id);
  c.loc = `${key}.${st.length}`;
  c.status = "inYard";
  if (record) recordMove(s, c, from, c.loc, "yard-in");
  return true;
}

/** Take a container out of the yard; dig out whatever sits on top of it. Returns rehandles. */
function retrieve(s, c, to) {
  const key = c.loc.split(".")[0];
  const st = s.yard.get(key);
  const idx = st.indexOf(c.id);
  const onTop = st.splice(idx + 1);
  st.pop(); // the container itself
  let rehandles = 0;
  for (const id of onTop) {
    const o = s.containers.get(id);
    const prev = o.loc;
    // A rehandle goes to another stack in the same block; never back onto this one.
    const targets = [...s.yard.keys()].filter((k) => k[0] === key[0] && k !== key && s.yard.get(k).length < TIERS);
    let target = targets[0];
    if (s.cfg.strategy === "random") target = targets[Math.floor(s.rng() * targets.length)];
    else for (const k of targets) if (s.yard.get(k).length < s.yard.get(target).length) target = k;
    if (!target) {
      st.push(id); // nowhere to go: leave it (rare, block full)
      continue;
    }
    s.yard.get(target).push(id);
    o.loc = `${target}.${s.yard.get(target).length}`;
    recordMove(s, o, prev, o.loc, "rehandle");
    rehandles++;
  }
  // Re-number tiers in the source stack.
  st.forEach((id, i) => (s.containers.get(id).loc = `${key}.${i + 1}`));
  recordMove(s, c, c.loc, to, "yard-out");
  c.loc = null;
  s.k.rehandles += rehandles;
  s.k.retrievals++;
  return rehandles;
}

function recordMove(s, c, from, to, kind) {
  s.moves.push({ t: s.t, container: c.id, from, to, kind });
  c.history.push({ t: s.t, kind, from, to });
}

export const above = (s, c) => {
  if (!c.loc) return 0;
  const [key, tier] = c.loc.split(".");
  return s.yard.get(key).length - Number(tier);
};

/* ---------- logging ---------- */

function log(s, level, text) {
  s.events.push({ t: s.t, level, text });
  if (s.events.length > 400) s.events.shift();
}

/* ---------- one minute of terminal time ---------- */

export function step(s) {
  const { rng, cfg } = s;
  const t = s.t;
  // Customs holds are checked at the gate, when a truck comes for the box.

  // Vessels: announce (BAPLIE) 6 h ahead, arrive, berth.
  for (const v of s.vessels) {
    if (!v.announced && t >= v.eta - 360) {
      v.announced = true;
      s.edi.push(baplie(s, v));
      log(s, "info", `BAPLIE received for ${v.name} (${v.discharge.length} to discharge).`);
    }
    if (v.status === "expected" && t >= v.eta) {
      v.status = "waiting";
      v.ata = t;
      log(s, "info", `${v.name} arrived at the pilot station.`);
    }
  }
  for (const b of s.berths) {
    if (b.vessel) continue;
    const next = s.vessels.find((v) => v.status === "waiting");
    if (!next) break;
    b.vessel = next.id;
    next.status = "berthed";
    next.berth = b.id;
    next.atb = t;
    s.k.berthWaitSum += t - next.ata;
    const cranes = b.id === "Q1" && cfg.craneDown ? 1 : CRANES_PER_VESSEL;
    next.cranes = Array.from({ length: cranes }, () => t + 20); // lashing / gangway first
    log(s, "ok", `${next.name} all fast at ${b.id} with ${cranes} crane${cranes > 1 ? "s" : ""}.`);
  }

  // Quay cranes.
  for (const b of s.berths) {
    if (!b.vessel) continue;
    const v = s.vessels.find((x) => x.id === b.vessel);
    s.k.craneMinutes += v.cranes.length;
    for (let i = 0; i < v.cranes.length; i++) {
      if (v.cranes[i] > t) continue;
      if (v.discharged < v.discharge.length) {
        const c = s.containers.get(v.discharge[v.discharged]);
        if (!place(s, c, true, `${v.id}/hold`)) break; // yard full: crane waits
        c.dischargedAt = t;
        if (rng() < cfg.customsHoldPct) c.holdUntil = t + 240 + Math.floor(rng() * 26 * 60);
        planPickup(s, c);
        v.discharged++;
        s.k.quayMoves++;
        v.cranes[i] = t + 2 + Math.round(rng() * 1.2);
        continue;
      }
      const ready = v.load.map((id) => s.containers.get(id)).filter((c) => c.status === "inYard");
      if (ready.length) {
        let c = ready[0]; // stowage-plan order
        if (cfg.strategy === "smart") for (const o of ready) if (above(s, o) < above(s, c)) c = o; // sequence: cheapest first
        const r = retrieve(s, c, `${v.id}/bay`);
        c.status = "loaded";
        v.loaded++;
        s.k.quayMoves++;
        v.cranes[i] = t + 2 + Math.round(rng() * 1.2) + r * 2;
        continue;
      }
    }
    const allDischarged = v.discharged >= v.discharge.length;
    const noneWaitingInYard = !v.load.some((id) => s.containers.get(id).status === "inYard");
    const cranesIdle = v.cranes.every((x) => x <= t);
    if (allDischarged && noneWaitingInYard && cranesIdle && t >= v.atb + 60) {
      const rolled = v.load.filter((id) => s.containers.get(id).status === "booked").length;
      s.k.rolled += rolled;
      v.status = "departed";
      v.atd = t;
      b.vessel = null;
      s.k.vesselsDone++;
      s.k.turnaroundSum += v.atd - v.ata;
      s.edi.push(coarri(s, v));
      log(s, rolled ? "warn" : "ok", `${v.name} sailed: ${v.discharged} off, ${v.loaded} on${rolled ? `, ${rolled} rolled (missed cut-off)` : ""}.`);
      for (const id of v.load) if (s.containers.get(id).status === "booked") s.containers.get(id).status = "rolled";
    }
  }

  // Trucks arrive for their appointment.
  const L = "ABCDEFGHJKLMNPRSTVWXYZ";
  for (const job of s.truckPlan.get(t) ?? []) {
    const plate = `1-${L[Math.floor(rng() * 22)]}${L[Math.floor(rng() * 22)]}${L[Math.floor(rng() * 22)]}-${100 + Math.floor(rng() * 899)}`;
    s.gate.queue.push({ ...job, plate, arrived: t });
  }
  s.truckPlan.delete(t);
  s.k.maxQueue = Math.max(s.k.maxQueue, s.gate.queue.length);

  // Gate lanes: check documents, then hand over to the yard.
  for (let l = 0; l < LANES; l++) {
    const lane = s.gate.lanes[l];
    if (l >= cfg.lanesOpen && !lane) continue;
    if (lane && lane.until <= t) {
      s.gate.lanes[l] = null;
      const c = s.containers.get(lane.container);
      if (lane.kind === "pickup" && c.holdUntil && c.holdUntil > t) {
        s.k.rejected++;
        s.k.trucksOut++;
        log(s, "err", `Gate ${l + 1}: ${lane.plate} refused, ${c.id} is on customs hold.`);
        planTruck(s, daytime(s, c.holdUntil + 60 + Math.floor(rng() * 240)), "pickup", c);
        continue;
      }
      s.gate.yardQueue.push(lane);
    }
    if (!s.gate.lanes[l] && l < cfg.lanesOpen && s.gate.queue.length) {
      const truck = s.gate.queue.shift();
      truck.until = t + 2 + Math.floor(rng() * 3);
      s.gate.lanes[l] = truck;
      s.k.trucksIn++;
      const c = s.containers.get(truck.container);
      s.edi.push(codeco(s, c, "in", truck.plate));
    }
  }

  // Yard equipment serves trucks.
  s.gate.equipmentBusy = s.gate.equipmentBusy.filter((job) => {
    if (job.until > t) return true;
    const c = s.containers.get(job.container);
    s.k.trucksOut++;
    s.k.tatSum += t - job.arrived;
    s.edi.push(codeco(s, c, "out", job.plate));
    return false;
  });
  while (s.gate.yardQueue.length && s.gate.equipmentBusy.length < YARD_EQUIPMENT) {
    const job = s.gate.yardQueue.shift();
    const c = s.containers.get(job.container);
    let r = 0;
    if (job.kind === "drop") {
      if (!place(s, c, true, `truck ${job.plate}`)) {
        s.gate.yardQueue.unshift(job);
        break;
      }
      c.gatedInAt = t;
    } else {
      r = retrieve(s, c, `truck ${job.plate}`);
      c.status = "delivered";
      s.k.dwellSum += t - c.dischargedAt;
      s.k.dwellCount++;
    }
    s.gate.equipmentBusy.push({ ...job, until: t + 5 + Math.floor(rng() * 4) + r * 3 });
  }

  s.t++;
}

/* ---------- read models ---------- */

export function kpis(s) {
  const k = s.k;
  let occupied = 0;
  for (const st of s.yard.values()) occupied += st.length;
  const capacity = s.yard.size * TIERS;
  return {
    clock: clockLabel(s.t),
    hours: s.t / 60,
    yardUtil: occupied / capacity,
    occupied,
    capacity,
    quayMoves: k.quayMoves,
    gcp: k.craneMinutes ? k.quayMoves / (k.craneMinutes / 60) : 0,
    rehandles: k.rehandles,
    rehandleRate: k.retrievals ? (100 * k.rehandles) / k.retrievals : 0,
    trucks: k.trucksOut,
    tat: k.trucksOut - k.rejected ? k.tatSum / (k.trucksOut - k.rejected) : 0,
    queue: s.gate.queue.length,
    maxQueue: k.maxQueue,
    rejected: k.rejected,
    rolled: k.rolled,
    vesselsDone: k.vesselsDone,
    turnaround: k.vesselsDone ? k.turnaroundSum / k.vesselsDone / 60 : 0,
    berthWait: s.vessels.filter((v) => v.atb !== null).length ? k.berthWaitSum / s.vessels.filter((v) => v.atb !== null).length / 60 : 0,
    dwell: k.dwellCount ? k.dwellSum / k.dwellCount / 60 : 0,
    edi: s.edi.length,
  };
}

export function blockFill(s) {
  const out = {};
  for (const b of BLOCKS) out[b.id] = 0;
  for (const [key, st] of s.yard) out[key[0]] += st.length;
  for (const b of BLOCKS) out[b.id] /= BAYS * ROWS * TIERS;
  return out;
}

/** Run a whole scenario without a screen, for comparisons and tests. */
export function run(config, hours = 72) {
  const s = createTerminal(config);
  for (let i = 0; i < hours * 60; i++) step(s);
  return s;
}

/** Physical move log as CSV, shaped like the MOVE_EVENT table in database/schema.sql. */
export function movesCsv(s) {
  const rows = ["move_ts,container_no,move_kind,from_loc,to_loc"];
  for (const m of s.moves) rows.push([new Date(START + m.t * 60000).toISOString(), m.container, m.kind, m.from, m.to].join(","));
  return rows.join("\n");
}
