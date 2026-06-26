# @adhd/apigen-plugin-py-grpc

apigen plugin: serve Python functions over gRPC using `grpcio` with in-memory protobuf descriptors and `grpc_reflection` enabled.

## Usage

```bash
apigen run --source my_api.py --type py-grpc --opt port=8950 --opt namespace=myapi
```

With grpcurl (no .proto file needed — reflection is always on):

```bash
grpcurl -plaintext \
  -d '{"data":{"amount":"123.456"}}' \
  localhost:8950 myapi.MyapiService/add_decimal
```

## Wire contract

- Service: `<namespace>.<Namespace>Service`
- Method: `/<namespace>.<Namespace>Service/<fn_name>`
- Request: typed sub-message per function (`message Data { string amount = 1; }`)
- Response: `string data = 1` (JSON-encoded result)

### Logical-type canon (never use `google.protobuf.Timestamp`)

| Python type        | Proto field type | Wire value          |
|--------------------|------------------|---------------------|
| `decimal.Decimal`  | `string`         | `"123.456"`         |
| `datetime.datetime`| `string`         | `"2024-01-15T12:34:56.789Z"` (RFC3339) |
| `uuid.UUID`        | `string`         | `"550e8400-e29b-..."`|
| `bytes`            | `string`         | base64 encoded      |
| `int`              | `int64`          | native              |
| `float`            | `double`         | native              |
| `bool`             | `bool`           | native              |

## Prerequisites

```bash
pip install grpcio grpcio-tools grpcio-reflection
```

## Live tests

```bash
APIGEN_PYGRPC_LIVE=1 npx nx test apigen-plugin-py-grpc
```
