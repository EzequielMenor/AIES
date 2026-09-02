import { describe, it, expect } from 'vitest';
import { truncate } from './string-utils.js';

describe('truncate', () => {
  it('returns original string if shorter than maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates string and appends ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('he...');
  });

  it('handles exact maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('supports custom ellipsis', () => {
    expect(truncate('hello world', 7, '…')).toBe('hello …');
  });

  it('handles maxLength smaller than ellipsis', () => {
    expect(truncate('hello', 2, '...')).toBe('..');
  });
});
