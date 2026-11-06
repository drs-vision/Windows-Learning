import { describe, expect, it } from 'vitest';
import { applySelection, pieces, toggle } from './highlights';

describe('highlights', () => {
  it('highlights a selection and joins touching ones', () => {
    expect(toggle([], 2, 5)).toEqual([[2, 5]]);
    expect(toggle([[2, 5]], 5, 9)).toEqual([[2, 9]]);
    expect(toggle([[2, 5]], 4, 9)).toEqual([[2, 9]]); // part new: the whole selection gets highlighted
  });
  it('selecting highlighted text again clears just that part', () => {
    expect(toggle([[2, 9]], 2, 9)).toEqual([]);
    expect(toggle([[2, 9]], 4, 6)).toEqual([[2, 4], [6, 9]]);
  });
  it('works across paragraphs', () => {
    const one = applySelection({}, [[0, 10, 20], [1, 0, 5]]);
    expect(one).toEqual({ 0: [[10, 20]], 1: [[0, 5]] });
    expect(applySelection(one, [[0, 12, 20], [1, 0, 5]])).toEqual({ 0: [[10, 12]] });
  });
  it('cuts a paragraph into pieces', () => {
    expect(pieces('abcdefgh', [[2, 4]]).map((p) => [p.text, p.mark])).toEqual([['ab', false], ['cd', true], ['efgh', false]]);
  });
});
