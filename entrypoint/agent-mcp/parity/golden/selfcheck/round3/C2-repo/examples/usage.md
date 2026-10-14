# Usage

## Totals

```js
import { computeTotal } from '../src/checkout.js';

computeTotal([{ price: 10, qty: 2 }], { discountCode: 'SAVE10' });
```

## Shipping Cost

### Small Order (Below $120)

Orders below $120 subtotal are charged a $3.99 shipping fee:

```js
import { shippingCost } from '../src/shipping.js';

shippingCost(50.00);  // Returns: 3.99
```

### Large Order (>= $120)

Orders $120 or more qualify for free shipping:

```js
import { shippingCost } from '../src/shipping.js';

shippingCost(120.00); // Returns: 0
shippingCost(250.00); // Returns: 0
```

## Checkout Summary

### With Items

Get a complete checkout summary including subtotal, discounts, shipping, and grand total:

```js
import { checkoutSummary } from '../src/summary.js';

const items = [
  { price: 50.00, qty: 1 },
  { price: 30.00, qty: 2 }
];

const summary = checkoutSummary(items, { discountCode: 'SAVE10' });
// Returns: {
//   subtotal: 110.00,
//   total: 99.00,
//   shipping: 3.99,
//   grandTotal: 102.99
// }
```

### Empty Cart

An empty cart returns all zeros:

```js
import { checkoutSummary } from '../src/summary.js';

const summary = checkoutSummary([]);
// Returns: {
//   subtotal: 0,
//   total: 0,
//   shipping: 0,
//   grandTotal: 0
// }
```
