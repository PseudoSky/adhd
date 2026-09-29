---
name: "usaddress — US address CRF parser (MIT, 4.9M/mo)"
topic: tool-catalog
tags: [agent:approved, tool, address, pii, parser]
project_path: /Users/nix/dev/ai/scratch
importance: 6
source: tool_output
data_quality: verified
summary: "usaddress (MIT, 0.5.16, ~4.9M/mo) is a US-only CRF address PARSER — cheap and fast. Approved as the SECOND-STAGE validator over address candidates a regex/context gate extracts; it is not a detector and does not cover non-US addresses."
metrics_source:
  version_license: "https://pypi.org/pypi/usaddress/json"
  downloads: "https://pypistats.org/api/packages/usaddress/recent"
---

name: usaddress
category: address detection (cat. 1/2)
description: Python library that parses unstructured US address strings into components (street, city, state, zip). A conditional-random-fields (CRF) tagger — much lighter than a transformer NER model.
scope_limits: US ONLY, and it is a PARSER not a DETECTOR — it parses an address string you already extracted; it does not find addresses in free text. Pair with a cheap regex/context gate ('street', ZIP-shape, 'Ave|St|Blvd|Suite') that extracts candidate strings, then usaddress validates/shapes them.
license: MIT. offline: yes. speed: fast CRF, per-line.
evidence: pypi usaddress → 0.5.16, "MIT License"; pypistats month 4,888,107 / week 1,263,875.
