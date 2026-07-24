# @adhd/apigen-plugin-py-grpc

apigen plugin: serve Python functions over gRPC using `grpcio` with in-memory protobuf descriptors and `grpc_reflection` enabled.

## Usage

```bash
apigen run --source my_api.py --type py-grpc --opt port=8950 --opt namespace=myapi
```

Internally this is a two-phase spawn (apigen-serve-core `py-grpc-serve-split`):
the plugin runs `apigen_python.extractor --emit-json` (extract-only), computes
each operation's canonical `package`/`service`/`method` via the REAL
`@adhd/apigen-engine-naming` `project(op).grpc` — the SAME projector every
other transport (fastify/express/mcp/cli) uses — and spawns
`apigen_python.grpc_server` with the result via `--plan-file`. The server no
longer self-extracts or derives its own naming.

With grpcurl (no .proto file needed — reflection is always on):

```bash
grpcurl -plaintext \
  -d '{"data":{"amount":"123.456"}}' \
  localhost:8950 myapi.my-api.MyApi/AddDecimal
```

## Wire contract

Service/method names are `@adhd/apigen-engine-naming`'s `project(op).grpc`
projection (`allSegs = [namespace, ...path]`):

- Package: dotted, snake_cased, every `allSegs` segment except the last (e.g. `myapi.my_api`)
- Service: Pascal-cased second-to-last segment — the "file" segment (e.g. `MyApi`)
- Method: Pascal-cased last segment — the "export" segment (e.g. `AddDecimal`)
- Full path: `/<package>.<Service>/<Method>` (e.g. `/myapi.my_api.MyApi/AddDecimal`)
- Request: typed sub-message per function (`message Data { string amount = 1; }`)
- Response: `string data = 1` (JSON-encoded result)

Streaming operations (`streaming: true`) are explicitly rejected with a clear
error at startup — gRPC natively supports streaming, but implementing it here
is a documented, tracked deferral, out of scope for this plugin today.

### Logical-type canon (never use `google.protobuf.Timestamp`)

| Python type         | Proto field type | Wire value                             |
| ------------------- | ---------------- | -------------------------------------- |
| `decimal.Decimal`   | `string`         | `"123.456"`                            |
| `datetime.datetime` | `string`         | `"2024-01-15T12:34:56.789Z"` (RFC3339) |
| `uuid.UUID`         | `string`         | `"550e8400-e29b-..."`                  |
| `bytes`             | `string`         | base64 encoded                         |
| `int`               | `int64`          | native                                 |
| `float`             | `double`         | native                                 |
| `bool`              | `bool`           | native                                 |

## Prerequisites

```bash
pip install grpcio grpcio-tools grpcio-reflection
```

## Live tests

```bash
APIGEN_PYGRPC_LIVE=1 npx nx test apigen-plugin-py-grpc
```
