# @adhd/apigen-plugin-py-flask

apigen plugin that serves Python `.py` modules over HTTP.

## Usage

```bash
apigen run --source my_api.py --type py-flask --opt port=8000
```

## Routes

| Method | Path              | Description                    |
|--------|-------------------|--------------------------------|
| GET    | /_meta/health     | Health check                   |
| POST   | /<ns>/<fn>        | Invoke function (unsafe ops)   |
| GET    | /<ns>/<fn>        | Invoke function (safe ops)     |

Request body for POST: `{"data": {"<param>": <value>, ...}}`

## Implementation

Uses Python stdlib `http.server.ThreadingHTTPServer` — Flask is listed as an optional
dependency in `pyproject.toml` but is not required. The stdlib implementation is
production-ready for the apigen use-case.

## Wire encoding

Logical types follow the canonical wire encoding:
- `decimal.Decimal` → decimal string (`"123.456"`)
- `datetime` → RFC3339 UTC string (`"2024-01-15T12:34:56.789Z"`)
- `bytes` → standard base64 (`"SGVsbG8="`)
- `uuid.UUID` → lowercase hyphenated string
