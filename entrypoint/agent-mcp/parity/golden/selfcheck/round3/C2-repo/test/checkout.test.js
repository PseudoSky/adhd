import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTotal } from '../src/checkout.js';

// [items, discountCode, expected total]
const CASES = [
  [[{"price":16.06,"qty":1},{"price":19.25,"qty":4}], 'SAVE10', 87.94],
  [[{"price":28.8,"qty":3},{"price":36.12,"qty":3},{"price":41.22,"qty":3}], 'SAVE10', 300.91],
  [[{"price":39.27,"qty":2},{"price":39.8,"qty":3}], 'SAVE20', 166.27],
  [[{"price":44.11,"qty":3}], 'SAVE10', 125.05],
  [[{"price":31.86,"qty":4},{"price":23.37,"qty":2},{"price":26.96,"qty":3}], 'SAVE10', 241.03],
  [[{"price":26.06,"qty":3},{"price":39.77,"qty":1}], 'VIP25', 92.89],
  [[{"price":38.36,"qty":1}], 'VIP25', 30.21],
  [[{"price":5.3,"qty":3},{"price":30.57,"qty":4},{"price":22.27,"qty":3}], 'SAVE10', 193.72],
  [[{"price":5.38,"qty":4},{"price":29.15,"qty":2}], 'VIP25', 62.86],
  [[{"price":33.91,"qty":2},{"price":25.99,"qty":4},{"price":21.28,"qty":3}], 'SAVE20', 197.92],
  [[{"price":30.28,"qty":4}], 'VIP25', 95.38],
  [[{"price":39.43,"qty":4}], 'SAVE20', 132.48],
  [[{"price":25.92,"qty":3},{"price":11.62,"qty":4},{"price":12.57,"qty":2}], 'VIP25', 117.64],
  [[{"price":28.96,"qty":2},{"price":30.84,"qty":1},{"price":39.39,"qty":1}], 'SAVE10', 121.1],
  [[{"price":14.5,"qty":1},{"price":25.2,"qty":1}], 'SAVE10', 37.52],
  [[{"price":19.94,"qty":3}], 'VIP25', 47.11],
  [[{"price":24.05,"qty":2},{"price":30.18,"qty":1}], 'SAVE10', 73.97],
  [[{"price":32.84,"qty":2},{"price":30.98,"qty":1},{"price":12.87,"qty":3}], 'SAVE20', 113.63],
  [[{"price":21.82,"qty":1}], 'SAVE20', 18.33],
  [[{"price":13.13,"qty":3},{"price":42.07,"qty":2},{"price":19.7,"qty":2}], 'VIP25', 128.31],
  [[{"price":39.24,"qty":3},{"price":15.67,"qty":4},{"price":7.67,"qty":1}], 'SAVE20', 157.98],
  [[{"price":42.57,"qty":2},{"price":41.15,"qty":2}], 'SAVE10', 158.23],
  [[{"price":6.55,"qty":2},{"price":16.94,"qty":1},{"price":23.74,"qty":3}], 'SAVE20', 85.06],
  [[{"price":44.29,"qty":3},{"price":43.26,"qty":3},{"price":8.26,"qty":2}], 'VIP25', 219.85],
  [[{"price":16.6,"qty":1},{"price":38.01,"qty":2}], 'VIP25', 72.94],
];

for (const [index, [items, code, expected]] of CASES.entries()) {
  test(`computeTotal case ${index + 1} (${code}, ${items.length} line items)`, () => {
    assert.equal(computeTotal(items, { discountCode: code }), expected);
  });
}
