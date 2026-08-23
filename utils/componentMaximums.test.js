import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  componentTotalMax,
  componentWeightage20,
  parseComponentMaximums,
} from './componentMaximums.js';

describe('component maximums', () => {
  it('accepts camelCase or snake_case overrides', () => {
    const maximums = parseComponentMaximums({
      participation: 15,
      writtenWork: 12,
      project_work: 8,
      slip_test: 25,
    });
    assert.deepEqual(maximums, {
      participation: 15,
      written_work: 12,
      project_work: 8,
      slip_test: 25,
    });
    assert.equal(componentTotalMax(maximums), 60);
  });

  it('falls back to 10/10/10/20 for invalid values', () => {
    const maximums = parseComponentMaximums({
      participation: 0,
      written_work: 1000,
      project_work: 'abc',
    });
    assert.equal(maximums.participation, 10);
    assert.equal(maximums.written_work, 10);
    assert.equal(maximums.project_work, 10);
    assert.equal(maximums.slip_test, 20);
  });

  it('scales weightage against the paper total, not a hardcoded 50', () => {
    const maximums = parseComponentMaximums({
      participation: 20,
      written_work: 20,
      project_work: 20,
      slip_test: 40,
    });
    assert.equal(componentWeightage20(80, maximums), 16);
  });
});
