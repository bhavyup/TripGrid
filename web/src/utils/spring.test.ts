import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILDER_PETALS,
  DIAL_SPRING,
  computeArcNodes,
  computeChoreographyFrame,
  describeEllipticalArc,
  describeEllipticalWedge,
  stepSpring,
} from "./spring";

test("stepSpring converges smoothly to target and settles", () => {
  let state = { value: -160, velocity: 0 };
  let settled = false;
  for (let i = 0; i < 180; i++) {
    const next = stepSpring(state, -45, DIAL_SPRING, 1 / 60);
    state = next.state;
    settled = next.settled;
    if (settled) break;
  }
  assert.equal(settled, true);
  assert.equal(state.value, -45);
  assert.equal(state.velocity, 0);
});

test("computeArcNodes places nodes symmetrically across the upper semicircle", () => {
  const nodes = computeArcNodes(5, 300, 200, -170, -10);
  assert.equal(nodes.length, 5);
  assert.equal(nodes[0].angleDeg, -170);
  assert.equal(nodes[2].angleDeg, -90);
  assert.equal(nodes[4].angleDeg, -10);
  assert.ok(Math.abs(nodes[2].x) < 1e-6);
  assert.ok(Math.abs(nodes[2].y + 200) < 1e-6);
  assert.ok(Math.abs(nodes[0].x + nodes[4].x) < 1e-6);
  assert.ok(Math.abs(nodes[0].y - nodes[4].y) < 1e-6);
});

test("describeEllipticalArc and describeEllipticalWedge build valid SVG geometry", () => {
  const d = describeEllipticalArc(400, 300, 280, 180, -172, -8);
  assert.ok(d.startsWith("M "));
  assert.ok(d.includes(" A 280 180 0 0 1 "));

  const wedge = describeEllipticalWedge(400, 300, 240, 150, 280, 180, -110, -70);
  assert.ok(wedge.startsWith("M "));
  assert.ok(wedge.endsWith(" Z"));
  assert.ok(wedge.includes("A 280 180 0 0 1"));
  assert.ok(wedge.includes("A 240 150 0 0 0"));
});

test("computeChoreographyFrame progresses through Mechanical -> Analog -> Digital -> Locked", () => {
  const start = computeChoreographyFrame(0, 2400);
  assert.equal(start.progress, 0);
  assert.equal(start.act, "mechanical");
  assert.equal(start.stageIndex, 0);
  assert.equal(start.tracePct, 0);
  assert.equal(start.digitalPct, 0);

  const mechMid = computeChoreographyFrame(360, 2400);
  assert.equal(mechMid.act, "mechanical");
  assert.ok(mechMid.mechanicalPct > 0.5 && mechMid.mechanicalPct < 1);

  const analogMid = computeChoreographyFrame(1200, 2400);
  assert.equal(analogMid.act, "analog");
  assert.equal(analogMid.stageIndex, 1);
  assert.ok(analogMid.tracePct > 0.7);
  assert.ok(analogMid.analogPct > 0.4);
  assert.equal(analogMid.digitalPct, 0);

  const digitalLate = computeChoreographyFrame(2000, 2400);
  assert.equal(digitalLate.act, "digital");
  assert.ok(digitalLate.digitalPct > 0.4 && digitalLate.digitalPct < 1);
  assert.ok(digitalLate.tracePct > 0.99);

  const end = computeChoreographyFrame(2400, 2400);
  assert.equal(end.progress, 1);
  assert.equal(end.act, "locked");
  assert.equal(end.stageIndex, 4);
  assert.equal(end.mechanicalPct, 1);
  assert.equal(end.tracePct, 1);
  assert.equal(end.analogPct, 1);
  assert.equal(end.scanPct, 1);
  assert.equal(end.digitalPct, 1);
  assert.equal(end.scopePct, 1);
});

test("BUILDER_PETALS defines 5 radial configuration bays", () => {
  assert.equal(BUILDER_PETALS.length, 5);
  assert.deepEqual(
    BUILDER_PETALS.map((p) => p.id),
    ["measures", "dimensions", "geography", "schedule", "range"],
  );
});
