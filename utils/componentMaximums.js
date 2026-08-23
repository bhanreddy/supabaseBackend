export const DEFAULT_COMPONENT_MAXIMUMS = Object.freeze({
  participation: 10,
  written_work: 10,
  project_work: 10,
  slip_test: 20,
});

const MAX_PER_COMPONENT = 999;

function numberInRange(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_PER_COMPONENT) return fallback;
  return parsed;
}

export function parseComponentMaximums(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    participation: numberInRange(
      source.participation ?? source.participation_max_marks,
      DEFAULT_COMPONENT_MAXIMUMS.participation,
    ),
    written_work: numberInRange(
      source.written_work ?? source.writtenWork ?? source.written_work_max_marks,
      DEFAULT_COMPONENT_MAXIMUMS.written_work,
    ),
    project_work: numberInRange(
      source.project_work ?? source.projectWork ?? source.project_work_max_marks,
      DEFAULT_COMPONENT_MAXIMUMS.project_work,
    ),
    slip_test: numberInRange(
      source.slip_test ?? source.slipTest ?? source.slip_test_max_marks,
      DEFAULT_COMPONENT_MAXIMUMS.slip_test,
    ),
  };
}

export function componentTotalMax(maximums) {
  return maximums.participation + maximums.written_work + maximums.project_work + maximums.slip_test;
}

export function componentMaximumsFromRow(row) {
  if (!row) return { ...DEFAULT_COMPONENT_MAXIMUMS };
  return parseComponentMaximums({
    participation: row.participation_max_marks,
    written_work: row.written_work_max_marks,
    project_work: row.project_work_max_marks,
    slip_test: row.slip_test_max_marks,
  });
}

export function componentWeightage20(componentTotal, paperMaximums) {
  const maximum = componentTotalMax(paperMaximums);
  if (!maximum) return null;
  return Number(((Number(componentTotal || 0) / maximum) * 20).toFixed(2));
}
