// UN/EDIFACT messages as a terminal sends and receives them (simplified subsets of
// SMDG/ITIGG message guides). Each builder returns { t, type, ref, about, text }.

const TERMINAL = "NKCT"; // Noordkaai Container Terminal (fictional)
const START = Date.UTC(2026, 10, 2, 6, 0);

const stamp = (t) => {
  const d = new Date(START + t * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    long: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`,
    short: `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}:${p(d.getUTCHours())}${p(d.getUTCMinutes())}`,
  };
};

/** Wrap message segments in an interchange; UNT counts UNH..UNT inclusive. */
function envelope(s, type, version, partner, body) {
  const ref = String(s.seq++).padStart(6, "0");
  const ts = stamp(s.t);
  const msg = [`UNH+${ref}+${type}:D:95B:UN:${version}`, ...body];
  msg.push(`UNT+${msg.length + 1}+${ref}`);
  const text = [`UNB+UNOA:2+${TERMINAL}+${partner}+${ts.short}+${ref}`, ...msg, `UNZ+1+${ref}`].map((x) => x + "'").join("\n");
  return { ref, text, partner };
}

const owner = (c) => c.id.slice(0, 4);

export function coparn(s, c, v) {
  const booking = `BK${v.id}${c.id.slice(4, 8)}`;
  const env = envelope(s, "COPARN", "ITG13", owner(c), [
    `BGM+126+${booking}+9`,
    `TDT+20+${v.voyage}+1++${owner(c)}:172:20+++:::${v.name.toUpperCase()}`,
    `RFF+BN:${booking}`,
    `NAD+CF+${owner(c)}:160:20`,
    `EQD+CN+${c.id}+${c.type}:102:5++2+5`,
    `LOC+11+${c.pod}:139:6`,
    `MEA+AAE+G+KGM:${c.weight * 1000}`,
    `CNT+16:1`,
  ]);
  return { t: s.t, type: "COPARN", about: c.id, ...env };
}

export function codeco(s, c, direction, plate) {
  const ts = stamp(s.t);
  const env = envelope(s, "CODECO", "ITG14", owner(c), [
    `BGM+${direction === "in" ? 34 : 36}+${c.id}${direction === "in" ? "I" : "O"}+9`,
    `NAD+CF+${owner(c)}:160:20`,
    `EQD+CN+${c.id}+${c.type}:102:5++${c.category === "import" ? 3 : 2}+5`,
    `RFF+${c.category === "import" ? "BM" : "BN"}:${c.vessel}${c.id.slice(4, 8)}`,
    `DTM+7:${ts.long}:203`,
    `LOC+165+BEZEE:139:6+${TERMINAL}:TER:ZZZ`,
    `MEA+AAE+G+KGM:${c.weight * 1000}`,
    `TDT+1++3+31+++:::${plate}`,
    `CNT+16:1`,
  ]);
  return { t: s.t, type: "CODECO", about: `${c.id} gate-${direction}`, ...env };
}

export function baplie(s, v) {
  const ts = stamp(s.t);
  const body = [`BGM++${v.id}${v.voyage}+9`, `DTM+137:${ts.long}:201`, `TDT+20+${v.voyage}+++${TERMINAL}:172:20+++:::${v.name.toUpperCase()}`, `LOC+5+BEZEE:139:6`];
  v.discharge.forEach((id, i) => {
    const c = s.containers.get(id);
    const bay = String(1 + 2 * Math.floor(i / 24)).padStart(3, "0");
    const row = String(1 + (i % 12)).padStart(2, "0");
    const tier = String(82 + 2 * Math.floor((i % 24) / 12)).padStart(2, "0");
    body.push(`LOC+147+${bay}${row}${tier}::5`, `MEA+WT++KGM:${c.weight * 1000}`, `LOC+9+GBTIL:139:6`, `LOC+11+BEZEE:139:6`, `EQD+CN+${c.id}+${c.type}+++5`);
  });
  const env = envelope(s, "BAPLIE", "SMDG20", "CARRIER", body);
  return { t: s.t, type: "BAPLIE", about: `${v.name} · ${v.discharge.length} units`, ...env };
}

export function coarri(s, v) {
  const ts = stamp(s.t);
  const body = [`BGM+270+${v.id}${v.voyage}+9`, `TDT+20+${v.voyage}+1++${TERMINAL}:172:20+++:::${v.name.toUpperCase()}`];
  for (const id of v.discharge.slice(0, v.discharged)) body.push(`EQD+CN+${id}`, `DTM+203:${ts.long}:203`, `LOC+147+::5`);
  for (const id of v.load) {
    const c = s.containers.get(id);
    if (c.status === "loaded") body.push(`EQD+CN+${id}`, `LOC+11+${c.pod}:139:6`);
  }
  body.push(`CNT+16:${v.discharged + v.loaded}`);
  const env = envelope(s, "COARRI", "ITG12", "CARRIER", body);
  return { t: s.t, type: "COARRI", about: `${v.name} · ${v.discharged} off / ${v.loaded} on`, ...env };
}

/** Light validation, the same checks the EDI monitor does: envelope, counts, equipment ids. */
export function validate(text) {
  const segs = text.split("'").map((x) => x.trim()).filter(Boolean);
  const errors = [];
  if (!segs[0]?.startsWith("UNB+")) errors.push("missing UNB");
  if (!segs.at(-1)?.startsWith("UNZ+")) errors.push("missing UNZ");
  const unh = segs.findIndex((x) => x.startsWith("UNH+"));
  const unt = segs.findIndex((x) => x.startsWith("UNT+"));
  if (unh < 0 || unt < 0) errors.push("missing UNH/UNT");
  else if (Number(segs[unt].split("+")[1]) !== unt - unh + 1) errors.push(`UNT says ${segs[unt].split("+")[1]} segments, counted ${unt - unh + 1}`);
  return errors;
}
