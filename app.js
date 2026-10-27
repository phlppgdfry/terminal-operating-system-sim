import { BLOCKS, BAYS, ROWS, TIERS, LANES, YARD_EQUIPMENT, createTerminal, step, run, kpis, blockFill, stackKey, clockLabel, movesCsv } from "./sim/engine.js";
import { validate } from "./sim/edi.js";

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);

const settings = {
  seed: Number(params.get("seed")) || 42,
  strategy: params.get("strategy") === "random" ? "random" : "smart",
  lanesOpen: 4,
  craneDown: false,
  customsHoldPct: 0.12,
};
let s = createTerminal(settings);
let playing = false;
let speed = 60; // simulated minutes per real second
let carry = 0;
let last = performance.now();
let selected = null; // stack key in the inspector
let highlight = null; // container id from search
let ediFilter = "ALL";
let flash = new Set();

/* ---------- build the static parts once ---------- */

const yardEl = $("#yard");
const cells = new Map();
for (const b of BLOCKS) {
  const wrap = document.createElement("div");
  wrap.className = "block";
  wrap.innerHTML = `<div class="bh"><b>Block ${b.id}</b><span id="fill-${b.id}"></span></div><div class="cells" role="grid" aria-label="Block ${b.id}, ${b.use}"></div>`;
  const grid = wrap.querySelector(".cells");
  for (let row = 1; row <= ROWS; row++) {
    for (let bay = 1; bay <= BAYS; bay++) {
      const key = stackKey(b.id, bay, row);
      const cell = document.createElement("button");
      cell.className = "cell h0";
      cell.title = key;
      cell.setAttribute("aria-label", `Stack ${key}`);
      cell.addEventListener("click", () => {
        selected = key;
        highlight = null;
        render(true);
      });
      grid.appendChild(cell);
      cells.set(key, cell);
    }
  }
  yardEl.appendChild(wrap);
}

const kpiDefs = [
  ["yard", "Yard utilisation"],
  ["gcp", "Crane productivity"],
  ["reh", "Rehandles"],
  ["tat", "Truck turnaround"],
  ["queue", "Gate queue"],
  ["turn", "Vessel turnaround"],
  ["rej", "Customs refusals"],
  ["rolled", "No-shows rolled"],
];
$("#kpis").innerHTML = kpiDefs.map(([id, label]) => `<div class="kpi" id="k-${id}"><div class="v">–</div><div class="l">${label}</div><div class="d"></div></div>`).join("");

/* ---------- rendering ---------- */

const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function setKpi(id, value, detail = "", tone = "") {
  const el = $(`#k-${id}`);
  el.className = `kpi ${tone}`;
  el.querySelector(".v").textContent = value;
  el.querySelector(".d").textContent = detail;
}

let lastEdiLen = -1;
let lastLogLen = -1;
let lastMoves = 0;

function render(force = false) {
  const k = kpis(s);
  $("#clock").textContent = k.clock;
  $("#hourCount").textContent = `hour ${Math.floor(k.hours)}`;

  setKpi("yard", pct(k.yardUtil), `${k.occupied} / ${k.capacity} slots`, k.yardUtil > 0.85 ? "warn" : "");
  setKpi("gcp", k.gcp.toFixed(1), "moves per crane-hour");
  setKpi("reh", String(k.rehandles), `${k.rehandleRate.toFixed(0)} per 100 retrievals`);
  setKpi("tat", `${k.tat.toFixed(0)} min`, `${k.trucks} trucks served`, k.tat > 30 ? "warn" : "");
  setKpi("queue", String(k.queue), `max ${k.maxQueue}`, k.queue > 20 ? "err" : k.queue > 8 ? "warn" : "");
  setKpi("turn", `${k.turnaround.toFixed(1)} h`, `${k.vesselsDone} vessels sailed`);
  setKpi("rej", String(k.rejected), "pickups refused at gate", k.rejected ? "warn" : "");
  setKpi("rolled", String(k.rolled), "missed the cut-off");

  // Quay
  $("#berths").innerHTML = s.berths
    .map((b) => {
      const v = s.vessels.find((x) => x.id === b.vessel);
      if (!v) return `<div class="berth idle"><div class="head"><span>${b.id}</span><span>free</span></div><div class="name">No vessel alongside</div></div>`;
      const loadReady = v.load.filter((id) => ["inYard", "loaded"].includes(s.containers.get(id).status)).length;
      const broken = b.id === "Q1" && s.cfg.craneDown;
      return `<div class="berth">
        <div class="head"><span>${b.id} · ${v.voyage}</span><span>alongside since ${clockLabel(v.atb).slice(4)}</span></div>
        <div class="name">${esc(v.name)}</div>
        <div class="prog dis"><span>Discharge</span><span class="bar"><i style="width:${(100 * v.discharged) / v.discharge.length}%"></i></span><span>${v.discharged}/${v.discharge.length}</span></div>
        <div class="prog load"><span>Load</span><span class="bar"><i style="width:${(100 * v.loaded) / Math.max(1, loadReady)}%"></i></span><span>${v.loaded}/${loadReady}</span></div>
        <div class="cranes">${v.cranes.length} crane${v.cranes.length > 1 ? "s" : ""} working${broken ? ' · <b>1 crane out of service</b>' : ""}</div>
      </div>`;
    })
    .join("");
  $("#arrivals").innerHTML = s.vessels
    .filter((v) => v.status === "expected" || v.status === "waiting")
    .slice(0, 5)
    .map((v) => `<li class="${v.status}"><span>${esc(v.name)} <small class="muted">${v.discharge.length}/${v.load.length}</small></span><span>${v.status === "waiting" ? "waiting" : "ETA " + clockLabel(v.eta)}</span></li>`)
    .join("") || `<li><span class="muted">No more calls in the schedule</span><span></span></li>`;

  // Yard
  const fills = blockFill(s);
  for (const b of BLOCKS) $(`#fill-${b.id}`).textContent = `${b.use} · ${pct(fills[b.id])}`;
  const hitStack = highlight && s.containers.get(highlight)?.loc?.split(".")[0];
  for (const [key, cell] of cells) {
    const st = s.yard.get(key);
    let cat = "imp";
    if (st.length) {
      const top = s.containers.get(st[st.length - 1]);
      cat = top.reefer ? "rf" : top.category === "export" ? "exp" : "imp";
    }
    let cls = `cell ${cat} h${st.length}`;
    if (key === hitStack) cls += " hit";
    if (key === selected) cls += " sel";
    if (flash.has(key)) cls += " flash";
    if (cell.className !== cls) cell.className = cls;
  }
  renderInspector();

  // Gate
  $("#gateSub").textContent = `${s.cfg.lanesOpen} of ${LANES} lanes open`;
  $("#lanesView").innerHTML = s.gate.lanes
    .map((lane, i) => {
      const closed = i >= s.cfg.lanesOpen;
      if (closed && !lane) return `<div class="lane closed"><div class="ln"><span>Lane ${i + 1}</span><span>closed</span></div></div>`;
      if (!lane) return `<div class="lane"><div class="ln"><span>Lane ${i + 1}</span><span>open</span></div><div class="tr muted">—</div></div>`;
      return `<div class="lane busy"><div class="ln"><span>Lane ${i + 1}</span><span>${lane.kind === "drop" ? "export in" : "import out"}</span></div><div class="tr">${esc(lane.plate)}</div><div class="tr muted">${lane.container}</div></div>`;
    })
    .join("");
  $("#queueLen").textContent = k.queue;
  $("#queueBar").style.width = `${Math.min(100, (k.queue / 40) * 100)}%`;
  $("#queueBar").classList.toggle("hot", k.queue > 20);
  $("#equip").textContent = `${s.gate.equipmentBusy.length}/${YARD_EQUIPMENT}`;
  $("#equipBar").style.width = `${(100 * s.gate.equipmentBusy.length) / YARD_EQUIPMENT}%`;

  // EDI
  if (force || s.edi.length !== lastEdiLen) {
    lastEdiLen = s.edi.length;
    $("#ediCount").textContent = `${s.edi.length} messages`;
    const list = s.edi.filter((m) => m.t <= s.t && (ediFilter === "ALL" || m.type === ediFilter)).slice(-60).reverse();
    $("#edi").innerHTML = list
      .map((m) => `<li data-ref="${m.ref}"><span class="tm">${clockLabel(Math.max(0, m.t)).slice(4)}</span><span class="ty ${m.type}">${m.type}</span><span class="ab">${esc(m.about)}</span></li>`)
      .join("");
  }

  // Log
  if (force || s.events.length !== lastLogLen) {
    lastLogLen = s.events.length;
    $("#log").innerHTML = s.events
      .slice(-80)
      .reverse()
      .map((e) => `<li><span class="tm">${clockLabel(e.t)}</span><span class="${e.level}">${esc(e.text)}</span></li>`)
      .join("");
  }
}

function renderInspector() {
  const el = $("#inspector");
  const key = selected ?? (highlight && s.containers.get(highlight)?.loc?.split(".")[0]);
  const c = highlight && s.containers.get(highlight);
  if (!key && !c) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  let html = "";
  if (key) {
    const st = s.yard.get(key) ?? [];
    html += `<h4>Stack ${key} · ${st.length}/${TIERS} high</h4><div class="stackview">${
      st
        .map((id, i) => {
          const o = s.containers.get(id);
          return `<div class="box ${o.reefer ? "reefer" : o.category} ${id === highlight ? "hl" : ""}" data-id="${id}"><small>T${i + 1}</small><span>${id}</span><small>${o.category}${o.category === "export" ? " · " + o.vessel + " · " + o.pod : ""}${o.holdUntil && o.holdUntil > s.t ? " · HOLD" : ""}</small></div>`;
        })
        .join("") || '<p class="muted">Empty stack.</p>'
    }</div>`;
  }
  if (c) {
    const v = s.vessels.find((x) => x.id === c.vessel);
    html += `<h4 style="margin-top:12px">${c.id} · ${c.type} · ${c.weight} t</h4>
      <p class="muted" style="margin:0">${c.category}${v ? " · " + esc(v.name) : ""} · status <b>${c.status}</b>${c.loc ? " · at " + c.loc : ""}${c.holdUntil && c.holdUntil > s.t ? " · customs hold until " + clockLabel(c.holdUntil) : ""}${c.plannedAt != null && c.status !== "delivered" ? " · truck slot " + clockLabel(c.plannedAt) : ""}</p>
      <ol class="history">${c.history.map((h) => `<li>${clockLabel(h.t)} <b>${h.kind}</b> ${esc(h.from)} → ${esc(h.to)}</li>`).join("") || "<li>No moves yet.</li>"}</ol>`;
  }
  el.innerHTML = html;
}

$("#inspector").addEventListener("click", (e) => {
  const box = e.target.closest(".box");
  if (!box) return;
  highlight = box.dataset.id;
  render(true);
});

/* ---------- the clock ---------- */

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (playing) {
    carry += dt * speed;
    let n = Math.floor(carry);
    carry -= n;
    const before = s.moves.length;
    while (n-- > 0) step(s);
    flash = new Set(s.moves.slice(Math.max(before, s.moves.length - 40)).map((m) => (m.to || "").split(".")[0]).filter((k) => cells.has(k)));
    render();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function setPlaying(p) {
  playing = p;
  $("#play").textContent = p ? "❚❚ Pause" : "▶ Play";
  $("#play").setAttribute("aria-label", p ? "Pause" : "Play");
}

$("#play").addEventListener("click", () => setPlaying(!playing));
$("#hour").addEventListener("click", () => {
  for (let i = 0; i < 60; i++) step(s);
  render(true);
});
$("#reset").addEventListener("click", reset);

function reset() {
  settings.seed = Math.max(1, Number($("#seed").value) || 42);
  s = createTerminal(settings);
  selected = null;
  highlight = null;
  lastEdiLen = lastLogLen = -1;
  render(true);
}

function segment(id, onPick) {
  const el = $(id);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    for (const x of el.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    onPick(b.dataset.v ?? b.dataset.speed);
  });
}
segment("#speed", (v) => (speed = Number(v)));
segment("#strategy", (v) => (settings.strategy = v));
segment("#lanes", (v) => {
  settings.lanesOpen = Number(v);
  s.cfg.lanesOpen = Number(v); // the gate can change live
  render(true);
});
segment("#crane", (v) => (settings.craneDown = v === "down"));
segment("#holds", (v) => (settings.customsHoldPct = Number(v)));
segment("#ediFilter", (v) => {
  ediFilter = v;
  render(true);
});
for (const b of document.querySelectorAll("#strategy button")) b.setAttribute("aria-pressed", String(b.dataset.v === settings.strategy));
$("#seed").value = settings.seed;

/* ---------- search ---------- */

$("#find").addEventListener("input", (e) => {
  const q = e.target.value.trim().toUpperCase();
  if (q.length < 4) {
    highlight = null;
    render(true);
    return;
  }
  const hit = [...s.containers.values()].find((c) => c.id.startsWith(q) && c.loc) ?? [...s.containers.values()].find((c) => c.id.startsWith(q));
  highlight = hit?.id ?? null;
  selected = null;
  render(true);
});

/* ---------- EDI dialog ---------- */

$("#edi").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  const m = s.edi.find((x) => x.ref === li.dataset.ref);
  if (!m) return;
  const errors = validate(m.text);
  $("#msgTitle").textContent = `${m.type} · ${m.ref} · ${m.about}`;
  $("#msgCheck").textContent = errors.length ? `✗ ${errors.join(", ")}` : "✓ envelope and segment count valid";
  $("#msgCheck").className = errors.length ? "bad" : "ok";
  $("#msgText").textContent = m.text;
  $("#msg").showModal();
});
$("#copyMsg").addEventListener("click", () => navigator.clipboard?.writeText($("#msgText").textContent));

/* ---------- compare & export ---------- */

$("#compare").addEventListener("click", () => {
  const out = $("#compareOut");
  out.innerHTML = '<p class="muted">Running 2 × 72 hours…</p>';
  setTimeout(() => {
    const base = { ...settings, seed: Math.max(1, Number($("#seed").value) || 42) };
    const r = kpis(run({ ...base, strategy: "random" }, 72));
    const m = kpis(run({ ...base, strategy: "smart" }, 72));
    const rows = [
      ["Rehandles", r.rehandles, m.rehandles, (x) => x, true],
      ["Rehandles per 100 retrievals", r.rehandleRate, m.rehandleRate, (x) => x.toFixed(0), true],
      ["Crane productivity (moves/crane-h)", r.gcp, m.gcp, (x) => x.toFixed(1), false],
      ["Vessel turnaround (h)", r.turnaround, m.turnaround, (x) => x.toFixed(1), true],
      ["Truck turnaround (min)", r.tat, m.tat, (x) => x.toFixed(0), true],
      ["Max gate queue", r.maxQueue, m.maxQueue, (x) => x, true],
      ["Vessels sailed", r.vesselsDone, m.vesselsDone, (x) => x, false],
    ];
    const cell = (a, b, f, lowerBetter) => {
      if (a === b) return `<td>${f(b)}</td>`;
      const better = lowerBetter ? b < a : b > a;
      return `<td class="${better ? "better" : "worse"}">${f(b)}</td>`;
    };
    const saved = r.rehandles ? Math.round(100 * (1 - m.rehandles / r.rehandles)) : 0;
    out.innerHTML = `<table><thead><tr><th>Seed ${base.seed}</th><th>Random</th><th>Smart</th></tr></thead><tbody>${rows
      .map(([label, a, b, f, lb]) => `<tr><td>${label}</td><td>${f(a)}</td>${cell(a, b, f, lb)}</tr>`)
      .join("")}</tbody></table>
      <p class="note">Smart allocation keeps each vessel and port of discharge together and loads the easiest box first. Here it saves <b>${saved}%</b> of rehandles. Every rehandle is a crane or straddle-carrier move that earns nothing.</p>`;
  }, 30);
});

$("#csv").addEventListener("click", () => {
  const blob = new Blob([movesCsv(s)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `noordkaai-moves-seed${s.cfg.seed}-h${Math.floor(s.t / 60)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------- guided tour (?tour) ---------- */

const tour = [
  { el: null, title: "A container terminal, minute by minute", text: "Noordkaai is a fictional terminal. Ships, trucks and EDI run on a deterministic model: the same seed always gives the same week. This tour takes two minutes." },
  { el: "#quayPanel", title: "The quay", text: "Vessels announce themselves with a BAPLIE six hours ahead, wait for a berth and work with two cranes: discharge first, then load what is in the yard.", run: 6 * 60 },
  { el: "#yardPanel", title: "The yard", text: "Every square is a stack, up to four high. Blue is import, amber export, purple reefer. Click a stack to look inside, or search a container number to follow it." },
  { el: "#gatePanel", title: "Gate and EDI", text: "Trucks come for their appointment, pass a lane and wait for a straddle carrier. Every gate move sends a CODECO; click any message to read the raw EDIFACT.", run: 4 * 60 },
  { el: "#kpis", title: "What the terminal manager watches", text: "Crane productivity, rehandles and truck turnaround move together. A box under three others costs three extra moves before it can leave." },
  { el: "#scenario", title: "Break something", text: "Switch to Random allocation, close two gate lanes or break the crane at Q1, then press Reset. Or run Compare strategies to see the difference over 72 hours." },
  { el: "#comparePanel", title: "Prove it", text: "The comparison runs the same week twice. The move log downloads as CSV in the shape of the MOVE_EVENT table in the Oracle schema, ready for a BI model.", compare: true },
];
let ti = 0;
function showTour(i) {
  ti = Math.max(0, Math.min(tour.length - 1, i));
  document.querySelectorAll(".spot").forEach((x) => x.classList.remove("spot"));
  const st = tour[ti];
  $("#tour").hidden = false;
  $("#tourStep").textContent = `${ti + 1} / ${tour.length}`;
  $("#tourTitle").textContent = st.title;
  $("#tourText").textContent = st.text;
  $("#tourPrev").disabled = ti === 0;
  $("#tourNext").textContent = ti === tour.length - 1 ? "Done" : "Next";
  if (st.run) {
    for (let k = 0; k < st.run; k++) step(s);
    render(true);
  }
  if (st.compare) $("#compare").click();
  if (st.el) {
    const el = $(st.el);
    el.classList.add("spot");
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  }
}
function closeTour() {
  $("#tour").hidden = true;
  document.querySelectorAll(".spot").forEach((x) => x.classList.remove("spot"));
}
$("#tourBtn").addEventListener("click", () => showTour(0));
$("#tourNext").addEventListener("click", () => (ti === tour.length - 1 ? closeTour() : showTour(ti + 1)));
$("#tourPrev").addEventListener("click", () => showTour(ti - 1));
$("#tourClose").addEventListener("click", closeTour);
addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTour();
  if (e.key === " " && !["INPUT", "BUTTON"].includes(document.activeElement.tagName)) {
    e.preventDefault();
    setPlaying(!playing);
  }
});

render(true);
if (params.has("tour")) showTour(0);
else if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setPlaying(true);
