# query

This library was generated with [Nx](https://nx.dev).

## Building

Run `nx build query` to build the library.

## Running unit tests

Run `nx test query` to execute the unit tests via [Vitest](https://vitest.dev/).

## Testing in a shell

```
nx build query

```
need to manually change the package.json in the dist removing the `type: "module"` line
```
ts-node --esm -P ./packages/query/tsconfig.json

> const Query = require('./dist/packages/query/index.js');
> const data = require('./packages/query/src/lib/test-data.json');
> const dv = new Query.DataView(data);
> dv.limit(10).orderBy([{reviews_aws_value: "desc"}]).where({}).view()
```