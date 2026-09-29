---
name: "libpostal/pypostal — international address parser (MIT, CAVEAT: parser not detector)"
topic: tool-catalog
tags: [agent:approved, tool, address, parser, libpostal, caveat]
project_path: /Users/nix/dev/ai/scratch
importance: 6
source: tool_output
data_quality: verified
summary: "libpostal (MIT) is the best international address parser/normalizer, but it is a PARSER not a detector and needs a ~1.7GB data build — so it is NOT the address-DETECTION answer. Approved CONDITIONALLY: extract candidates cheaply (regex/context) then normalize with libpostal only if non-US normalization is required; otherwise usaddress (US) or Presidio LOCATION suffices. Beware the unrelated `pypostal` PyPI package."
metrics_source:
  binding_version_license: "https://pypi.org/pypi/postal/json"
  libpostal_license: "https://raw.githubusercontent.com/openvenues/libpostal/master/LICENSE"
---

name: libpostal / pypostal (the `postal` PyPI package)
category: address parsing at scale (cat. 1/2)
description: The reference international street-address parser/normalizer (C library, MIT). Python binding is the PyPI package `postal` (repo openvenues/pypostal).
NAME_COLLISION_WARNING: the PyPI package named `pypostal` (hudora/pyPostal) is an UNRELATED "send paper letters" library; do not install it by mistake.
critical_caveat: libpostal is a PARSER/NORMALIZER, NOT a detector — it needs an address string already extracted, plus a ~1.7GB data download and a C build. This is the common misconception (that libpostal "finds" addresses); it does not. For a reputation AUDIT, use a cheap extractor + Presidio LOCATION / usaddress first, and reach for libpostal only when non-US address NORMALIZATION is genuinely required.
license: MIT (verified from libpostal LICENSE). offline: yes (after model download).
related: oxidize-postal (PyPI 0.1.2, Rust bindings, no C build, releases GIL) is an emerging alternative; license unspecified (LOW confidence) — do not adopt yet.
evidence: pypi postal → 1.1.11, "MIT License"; libpostal LICENSE fetched (MIT); DDG confirms libpostal repo + the pypostal name collision.
