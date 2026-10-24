'use strict';
/**
 * The shop's departments. A computer belongs to at most one; it decides which view of a door order opens by default and nothing else:
 * any computer can still look at any department's view (the shop works in the open), and a department is not an access level (see roles.js).
 */
const DEPARTMENTS = ['CNC', 'Frame Prep', 'Paint', 'Assembly', 'Office'];

/** The department a name stands for ('' for none or anything unknown), matched without caring about case or spacing. */
function departmentOf(name) {
  const k = String(name == null ? '' : name).toLowerCase().replace(/[^a-z]/g, '');
  return DEPARTMENTS.find(d => d.toLowerCase().replace(/[^a-z]/g, '') === k) || '';
}

module.exports = { DEPARTMENTS, departmentOf };
