'use strict';
/**
 * Catching a door up: a door already in the shop has its progress written in the order form's Parts List (Cut, Prep, Filled, Paint Prep,
 * Painted, per part). This turns that into the board's status columns so the door lands on the right station, instead of starting over.
 *
 * The mapping is the shop's, written down here so it can be corrected in one place:
 *   Cut -> Material Cutting      (every frame part)       Prep -> CNC Frame   (side jambs and header)
 *   Filled -> Frame Filling      (side jambs and header)  Paint Prep -> Paint Prep, Painted -> Paint   (every frame part)
 * A step is only set when every part it covers has it done (or a later step is, which implies it), and nothing is ever set back. It shows
 * what it would do first.
 */
const STAGES = [
  { key: 'cut', column: 'Material Cutting', scope: 'all', word: 'cut' },
  { key: 'prep', column: 'CNC Frame', scope: 'core', word: 'prepped' },
  { key: 'filled', column: 'Frame Filling', scope: 'core', word: 'filled' },
  { key: 'paintprep', column: 'Paint Prep', scope: 'all', word: 'paint-prepped' },
  { key: 'painted', column: 'Paint', scope: 'all', word: 'painted' },
];
const CORE = /jambs?|header/i, NOT_FRAME = /other components/i;

/** What the Parts List says is finished: [{ column, why }]. */
function finishedSteps(sections) {
  const frame = sections.filter(s => !NOT_FRAME.test(s.title));
  const found = STAGES.map(st => {
    const group = st.scope === 'core' ? frame.filter(s => CORE.test(s.title)) : frame;
    const parts = group.flatMap(s => s.parts.filter(p => st.key in p.done));
    return parts.length && parts.every(p => p.done[st.key])
      ? { column: st.column, why: `All ${parts.length} ${st.scope === 'core' ? 'jamb and header ' : 'frame '}part${parts.length === 1 ? '' : 's'} ${parts.length === 1 ? 'is' : 'are'} ${st.word} on the order form` } : null;
  });
  // a step cannot be done before the ones ahead of it: if filling is finished, cutting and prep are too
  const last = found.map(Boolean).lastIndexOf(true);
  return STAGES.map((st, i) => found[i] || (i < last ? { column: st.column, why: `Implied: ${STAGES[last].column} is already done` } : null)).filter(Boolean);
}

function install(JobStore) {
  Object.assign(JobStore.prototype, {
    /** { found, steps: [{ column, field, label, why, already }] } for one door, from its order form's sections. */
    catchupPlan(ref, sections) {
      const fields = this.fields(), id = this.doorId(ref), cells = this.cellsOf(id), needs = this.needsOf(id);
      const steps = [];
      if (needs && needs.frame === false) return { steps, note: 'This door does not need a frame.' };
      for (const f of finishedSteps(sections)) {
        const field = fields.find(x => x.name.toLowerCase() === f.column.toLowerCase());
        const done = field && field.labels.find(l => l.done && !/not needed/i.test(l.name));
        if (!field || !done) continue;
        const cur = cells[field.id], curLabel = cur && cur.label != null ? field.labels.find(l => l.id === cur.label) : null;
        steps.push({ column: field.name, field: field.id, label: done.id, labelName: done.name, why: f.why, already: !!(curLabel && curLabel.done) });
      }
      return { steps };
    },
  });
}

module.exports = { install, finishedSteps, STAGES };
