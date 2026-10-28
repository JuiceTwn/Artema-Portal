'use strict';
/**
 * The shop's production flow, in one place. Nothing here touches a database.
 *
 *   Frame Prep [ cut → CNC → fill → QC ]  →  Paint [ paint prep → paint → QC ]  →  Assembly [ assemble → QC ]  →  Shipping [ ship ]
 *
 * Every department except Shipping ends with a QC by its lead hand; that sign-off is a step like any other, so "who passed it and
 * when" is recorded the same way. Each step is done at most once per door: that is what keeps flow numbers from being double
 * counted. Repairs are detours (jobs.js), never steps.
 */
const STAGES = [
  { id: 'frame-prep', dept: 'Frame Prep', steps: [['cut', 'Cut'], ['cnc', 'CNC'], ['fill', 'Fill']], qc: true },
  { id: 'paint', dept: 'Paint', steps: [['prep', 'Paint prep'], ['paint', 'Paint']], qc: true },
  { id: 'assembly', dept: 'Assembly', steps: [['assemble', 'Assembly']], qc: true },
  { id: 'shipping', dept: 'Shipping', steps: [['ship', 'Ship']], qc: false },
];

/** Every step in order: { key: 'frame-prep.cut', stage, dept, id, label, qc }. */
const STEPS = STAGES.flatMap(s => [
  ...s.steps.map(([id, label]) => ({ key: `${s.id}.${id}`, stage: s.id, dept: s.dept, id, label, qc: false })),
  ...(s.qc ? [{ key: `${s.id}.qc`, stage: s.id, dept: s.dept, id: 'qc', label: 'QC', qc: true }] : []),
]);
const STEP_KEYS = STEPS.map(s => s.key);
const stepOf = key => STEPS.find(s => s.key === key) || null;

/** The departments that appear in the flow, in order. */
const FLOW_DEPARTMENTS = STAGES.map(s => s.dept);

/**
 * Component kinds a door can need, and the step that cannot be completed until they have arrived. A component made in-house
 * by Frame Prep is marked ready by the cut step itself (see jobs.js); the others come from providers (Skins and Panel Assembly,
 * Rail & Stile, or an outside supplier).
 */
const COMPONENT_KINDS = ['frame', 'panel', 'rail_stile'];
const NEEDED_BEFORE = 'frame-prep.cnc';

/** What the office ticks off before releasing a door, until there is a real inventory. */
const DEFAULT_CHECKS = ['Glass', 'Hardware', 'Sill'];

/** The first step not yet done, given the set of keys already completed; null when the door is finished. */
function nextStep(done) {
  const d = done instanceof Set ? done : new Set(done);
  return STEPS.find(s => !d.has(s.key)) || null;
}

module.exports = { STAGES, STEPS, STEP_KEYS, stepOf, FLOW_DEPARTMENTS, COMPONENT_KINDS, NEEDED_BEFORE, DEFAULT_CHECKS, nextStep };
