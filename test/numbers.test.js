import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber } from '../src/numbers.js';

const cases = [
  ['$99.99', 99.99],
  ['US$ 1,299.00', 1299],
  ['€1.299,00', 1299],
  ['1 299,50 kr', 1299.5],
  ["CHF 1'299.90", 1299.9],
  ['1\u00a0299,50\u00a0€', 1299.5],
  ['12.5%', 12.5],
  ['12,5 %', 12.5],
  ['0.125', 0.125],
  ['0,125', 0.125],
  ['1,299', 1299],
  ['12.345.678', 12345678],
  ['-5.20', -5.2],
  ['\u22125.20', -5.2],
  ['Now only £49 (was £79)', 49],
  ['In stock: 3 left', 3],
  ['1234.56', 1234.56],
  ['1234,567', 1234.567],
  ['2024-05-01', 2024],
  ['No price available', null],
  ['', null],
];

for (const [input, expected] of cases) {
  test(`parseNumber(${JSON.stringify(input)})`, () => {
    assert.equal(parseNumber(input), expected);
  });
}
