# CDP Protocol Reference

This directory documents Chrome DevTools Protocol domains relevant to `@adhd/stealth-core-browser`.

## Quick Links

- [`protocol-overview.md`](./protocol-overview.md) — Protocol versioning, transport, message format, session model
- [`domains.md`](./domains.md) — Exhaustive index of ALL 57 CDP domains with methods, events, and types
- [`usage.md`](./usage.md) — How our `CdpSession` connects and uses the protocol
- [`target-domain.md`](./target-domain.md) — Target lifecycle, discovery, inspection
- [`target-timing.md`](./target-timing.md) — Deep dive on target timing: what's available and workarounds
- [`monitoring.md`](./monitoring.md) — Performance metrics, timestamps, histogram introspection
- [`api-reference.md`](./api-reference.md) — Method/event/type reference for `CdpSession` and the CDP verbs

## Chrome Version

This reference was built against Chrome 149 (tip-of-tree CDP protocol). The spec lives at [chromedevtools.github.io](https://chromedevtools.github.io/devtools-protocol/tot/).

## Domains Covered

All 57 CDP domains are documented in [`domains.md`](./domains.md), grouped by category:
- Browser/System: Browser, SystemInfo, Target, IO, Security, Storage
- Page/DOM: Page, DOM, DOMSnapshot, DOMDebugger, DOMStorage, CSS, Overlay, LayerTree
- Network: Network, Fetch, CacheStorage, BackgroundService, Preload
- JavaScript Runtime: Runtime, Debugger, Console, HeapProfiler, Profiler
- Performance: Performance, PerformanceTimeline, Memory, Tracing
- Input/Device: Input, Emulation, DeviceOrientation, DeviceAccess, BluetoothEmulation, SmartCardEmulation
- Audio/Media: WebAudio, Media, Animation
- Web Platform: WebAuthn, FedCm, PWA, Extensions, Autofill, FileSystem, Storage, IndexedDB, WebMCP
- Security: Security, Audits, Ads, CrashReportContext
- Other: Log, Inspector, Schema, Tethering, Cast, HeadlessExperimental, EventBreakpoints, DigitalCredentials, ServiceWorker, Accessibility
