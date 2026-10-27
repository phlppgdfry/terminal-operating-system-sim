import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDigit, createTerminal, step, run, kpis, TIERS, movesCsv } from "../sim/engine.js";
import { validate } from "../sim/edi.js";

test("ISO 6346 check digit matches the standard example", () => {
  assert.equal(checkDigit("CSQU305438"), 3);
  assert.equal(checkDigit("MSKU907032"), 3);
});

test("every container number is unique and carries a valid check digit", () => {
  const s = run({ seed: 3 }, 24);
  const ids = [...s.containers.keys()];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(Number(id[10]), checkDigit(id.slice(0, 10)), id);
});

test("same seed, same terminal", () => {
  assert.deepEqual(kpis(run({ seed: 11 }, 24)), kpis(run({ seed: 11 }, 24)));
});

test("the yard stays physically possible every minute", () => {
  const s = createTerminal({ seed: 5, strategy: "random" });
  for (let i = 0; i < 48 * 60; i++) {
    step(s);
    if (i % 60) continue;
    const where = new Map();
    for (const [key, stack] of s.yard) {
      assert.ok(stack.length <= TIERS, `${key} is ${stack.length} high`);
      stack.forEach((id, tier) => {
        assert.ok(!where.has(id), `${id} in two places`);
        where.set(id, `${key}.${tier + 1}`);
      });
    }
    for (const [id, loc] of where) assert.equal(s.containers.get(id).loc, loc, id);
  }
});

test("smart allocation digs less than random allocation, on every seed tried", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = kpis(run({ seed, strategy: "random" }, 72));
    const smart = kpis(run({ seed, strategy: "smart" }, 72));
    assert.ok(smart.rehandles < random.rehandles * 0.6, `seed ${seed}: ${smart.rehandles} vs ${random.rehandles}`);
    assert.ok(smart.gcp > random.gcp, `seed ${seed}: crane productivity`);
  }
});

test("closing gate lanes makes trucks wait longer", () => {
  const open = kpis(run({ seed: 42 }, 72));
  const half = kpis(run({ seed: 42, lanesOpen: 2 }, 72));
  assert.ok(half.tat > open.tat * 2, `${half.tat} vs ${open.tat}`);
});

test("a broken crane slows vessels down", () => {
  const ok = kpis(run({ seed: 42 }, 72));
  const broken = kpis(run({ seed: 42, craneDown: true }, 72));
  assert.ok(broken.turnaround > ok.turnaround);
});

test("customs holds stop pickups at the gate", () => {
  const none = kpis(run({ seed: 8, customsHoldPct: 0 }, 72));
  const many = kpis(run({ seed: 8, customsHoldPct: 0.4 }, 72));
  assert.equal(none.rejected, 0);
  assert.ok(many.rejected > 50);
});

test("every EDI message has a correct envelope and segment count", () => {
  const s = run({ seed: 2 }, 36);
  const types = new Set(s.edi.map((m) => m.type));
  for (const type of ["COPARN", "CODECO", "BAPLIE", "COARRI"]) assert.ok(types.has(type), type);
  for (const m of s.edi) assert.deepEqual(validate(m.text), [], `${m.type} ${m.ref}`);
});

test("the move log exports as CSV for the warehouse", () => {
  const csv = movesCsv(run({ seed: 4 }, 6)).split("\n");
  assert.equal(csv[0], "move_ts,container_no,move_kind,from_loc,to_loc");
  assert.ok(csv.length > 50);
  assert.match(csv[1], /^2026-11-02T/);
});
