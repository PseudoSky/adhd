# CDP Domains — Exhaustive Reference

Source: Tip-of-tree CDP protocol (Chrome 149+). Generated from `browser_protocol.pdl` and `js_protocol.pdl`.

---

## Browser / System

### Browser

Controls browser-level operations: window management, permissions, downloads, histograms, version info, privacy sandbox.

- **Methods:** `setPermission`, `grantPermissions` (deprecated), `resetPermissions`, `setDownloadBehavior`, `cancelDownload`, `close`, `crash`, `crashGpuProcess`, `getVersion`, `getBrowserCommandLine`, `getHistograms`, `getHistogram`, `getWindowBounds`, `getWindowForTarget`, `setWindowBounds`, `setContentsSize`, `setDockTile`, `executeBrowserCommand`, `addPrivacySandboxEnrollmentOverride`, `addPrivacySandboxCoordinatorKeyConfig`
- **Events:** `downloadWillBegin`, `downloadProgress`
- **Types:** `BrowserContextID`, `WindowID`, `WindowState`, `Bounds`, `PermissionType`, `PermissionSetting`, `PermissionDescriptor`, `Bucket`, `Histogram`, `BrowserCommandId`, `PrivacySandboxAPI`

### SystemInfo

Query low-level system and GPU information, process listing.

- **Methods:** `getInfo`, `getFeatureState`, `getProcessInfo`
- **Events:** none
- **Types:** `GPUDevice`, `Size`, `VideoDecodeAcceleratorCapability`, `VideoEncodeAcceleratorCapability`, `SubsamplingFormat`, `ImageType`, `GPUInfo`, `ProcessInfo`

### Target

Discover, create, attach to, and close debuggable targets (pages, iframes, workers, service workers, tabs).

- **Methods:** `activateTarget`, `attachToTarget`, `attachToBrowserTarget`, `closeTarget`, `exposeDevToolsProtocol`, `createBrowserContext`, `getBrowserContexts`, `createTarget`, `detachFromTarget`, `disposeBrowserContext`, `getTargetInfo`, `getTargets`, `sendMessageToTarget` (deprecated), `setAutoAttach`, `autoAttachRelated`, `setDiscoverTargets`, `setRemoteLocations`, `getDevToolsTarget`, `openDevTools`
- **Events:** `attachedToTarget`, `detachedFromTarget`, `receivedMessageFromTarget`, `targetCreated`, `targetDestroyed`, `targetCrashed`, `targetInfoChanged`
- **Types:** `TargetID`, `SessionID`, `TargetInfo`, `FilterEntry`, `TargetFilter`, `RemoteLocation`, `WindowState`

### IO

Stream I/O for reading/writing data produced by DevTools (response bodies, tracing data, PDFs).

- **Methods:** `close`, `read`, `resolveBlob`
- **Events:** none
- **Types:** `StreamHandle`

### Security

Page security state, certificate info, mixed content tracking.

- **Methods:** `disable`, `enable`, `setIgnoreCertificateErrors`, `handleCertificateError` (deprecated), `setOverrideCertificateErrors` (deprecated)
- **Events:** `certificateError` (deprecated), `visibleSecurityStateChanged`, `securityStateChanged` (deprecated)
- **Types:** `CertificateId`, `MixedContentType`, `SecurityState`, `CertificateSecurityState`, `SafetyTipStatus`, `SafetyTipInfo`, `VisibleSecurityState`, `SecurityStateExplanation`, `InsecureContentStatus` (deprecated), `CertificateErrorAction`

### Storage

Query and clear browser storage: cookies, caches, IndexedDB, shared storage, interest groups, storage buckets.

- **Methods:** `getStorageKeyForFrame` (deprecated), `getStorageKey`, `clearDataForOrigin`, `clearDataForStorageKey`, `getCookies`, `setCookies`, `clearCookies`, `getUsageAndQuota`, `overrideQuotaForOrigin`, `trackCacheStorageForOrigin`, `trackCacheStorageForStorageKey`, `trackIndexedDBForOrigin`, `trackIndexedDBForStorageKey`, `untrackCacheStorageForOrigin`, `untrackCacheStorageForStorageKey`, `untrackIndexedDBForOrigin`, `untrackIndexedDBForStorageKey`, `getTrustTokens`, `clearTrustTokens`, `getInterestGroupDetails`, `setInterestGroupTracking`, `setInterestGroupAuctionTracking`, `getSharedStorageMetadata`, `getSharedStorageEntries`, `setSharedStorageEntry`, `deleteSharedStorageEntry`, `clearSharedStorageEntries`, `resetSharedStorageBudget`, `setSharedStorageTracking`, `setStorageBucketTracking`, `deleteStorageBucket`, `runBounceTrackingMitigations`, `getRelatedWebsiteSets`, `setProtectedAudienceKAnonymity`
- **Events:** `cacheStorageContentUpdated`, `cacheStorageListUpdated`, `indexedDBContentUpdated`, `indexedDBListUpdated`, `interestGroupAccessed`, `interestGroupAuctionEventOccurred`, `interestGroupAuctionNetworkRequestCreated`, `sharedStorageAccessed`, `sharedStorageWorkletOperationExecutionFinished`, `storageBucketCreatedOrUpdated`, `storageBucketDeleted`
- **Types:** `SerializedStorageKey`, `StorageType`, `UsageForType`, `TrustTokens`, `InterestGroupAuctionId`, `InterestGroupAccessType`, `InterestGroupAuctionEventType`, `InterestGroupAuctionFetchType`, `SharedStorageAccessScope`, `SharedStorageAccessMethod`, `SharedStorageEntry`, `SharedStorageMetadata`, `SharedStoragePrivateAggregationConfig`, `SharedStorageReportingMetadata`, `SharedStorageUrlWithMetadata`, `SharedStorageAccessParams`, `StorageBucketsDurability`, `StorageBucket`, `StorageBucketInfo`, `RelatedWebsiteSet`

---

## Page / DOM

### Page

Actions and events related to the inspected page: navigation, screenshots, PDF, frame lifecycle, dialogs, app manifests, compilation cache.

- **Methods:** `addScriptToEvaluateOnLoad` (deprecated), `addScriptToEvaluateOnNewDocument`, `bringToFront`, `captureScreenshot`, `captureSnapshot`, `clearDeviceMetricsOverride` (deprecated/redirect), `clearDeviceOrientationOverride` (deprecated/redirect), `clearGeolocationOverride` (deprecated/redirect), `createIsolatedWorld`, `deleteCookie` (deprecated/redirect), `disable`, `enable`, `getAppManifest`, `getInstallabilityErrors`, `getManifestIcons` (deprecated), `getAppId`, `getAdScriptAncestry`, `getFrameTree`, `getLayoutMetrics`, `getNavigationHistory`, `resetNavigationHistory`, `getResourceContent`, `getResourceTree`, `handleJavaScriptDialog`, `navigate`, `navigateToHistoryEntry`, `printToPDF`, `reload`, `removeScriptToEvaluateOnLoad` (deprecated), `removeScriptToEvaluateOnNewDocument`, `screencastFrameAck`, `searchInResource`, `setAdBlockingEnabled`, `setBypassCSP`, `getPermissionsPolicyState`, `getOriginTrials`, `setDeviceMetricsOverride` (deprecated/redirect), `setDeviceOrientationOverride` (deprecated/redirect), `setFontFamilies`, `setFontSizes`, `setDocumentContent`, `setDownloadBehavior` (deprecated), `setGeolocationOverride` (deprecated/redirect), `setLifecycleEventsEnabled`, `setTouchEmulationEnabled` (deprecated/redirect), `startScreencast`, `stopLoading`, `crash`, `close`, `setWebLifecycleState`, `stopScreencast`, `produceCompilationCache`, `addCompilationCache`, `clearCompilationCache`, `setSPCTransactionMode`, `setRPHRegistrationMode`, `generateTestReport`, `waitForDebugger`, `setInterceptFileChooserDialog`
- **Events:** `domContentEventFired`, `fileChooserOpened`, `frameAttached`, `frameClearedScheduledNavigation` (deprecated), `frameDetached`, `frameSubtreeWillBeDetached`, `frameNavigated`, `documentOpened`, `frameResized`, `frameStartedNavigating`, `frameRequestedNavigation`, `frameScheduledNavigation` (deprecated), `frameStartedLoading`, `frameStoppedLoading`, `downloadWillBegin` (deprecated), `downloadProgress` (deprecated), `interstitialHidden`, `interstitialShown`, `javascriptDialogClosed`, `javascriptDialogOpening`, `lifecycleEvent`, `backForwardCacheNotUsed`, `loadEventFired`, `navigatedWithinDocument`, `screencastFrame`, `screencastVisibilityChanged`, `compilationCacheProduced`
- **Types:** `FrameId`, `AdFrameType`, `AdFrameExplanation`, `AdFrameStatus`, `SecureContextType`, `CrossOriginIsolatedContextType`, `GatedAPIFeatures`, `PermissionsPolicyFeature`, `PermissionsPolicyBlockReason`, `PermissionsPolicyBlockLocator`, `PermissionsPolicyFeatureState`, `OriginTrialTokenStatus`, `OriginTrialStatus`, `OriginTrialUsageRestriction`, `OriginTrialToken`, `OriginTrialTokenWithStatus`, `OriginTrial`, `SecurityOriginDetails`, `Frame`, `FrameResource`, `FrameResourceTree`, `FrameTree`, `ScriptIdentifier`, `TransitionType`, `NavigationEntry`, `ScreencastFrameMetadata`, `DialogType`, `AppManifestError`, `AppManifestParsedProperties`, `LayoutViewport`, `VisualViewport`, `Viewport`, `FontFamilies`, `ScriptFontFamilies`, `FontSizes`, `ClientNavigationReason`, `ClientNavigationDisposition`, `InstallabilityErrorArgument`, `InstallabilityError`, `ReferrerPolicy`, `CompilationCacheParams`, `FileFilter`, `FileHandler`, `ImageResource`, `LaunchHandler`, `ProtocolHandler`, `RelatedApplication`, `ScopeExtension`, `Screenshot`, `ShareTarget`, `Shortcut`, `WebAppManifest`, `NavigationType`, `BackForwardCacheNotRestoredReason`, `BackForwardCacheNotRestoredExplanation`

### DOM

DOM read/write operations — query, traverse, and modify the DOM tree. Each node has a `nodeId` and `backendNodeId`.

- **Methods:** `collectClassNamesFromSubtree`, `copyTo`, `describeNode`, `scrollIntoViewIfNeeded`, `disable`, `discardSearchResults`, `enable`, `focus`, `getAttributes`, `getBoxModel`, `getContentQuads`, `getDocument`, `getFlattenedDocument` (deprecated), `getNodesForSubtreeByStyle`, `getNodeForLocation`, `getOuterHTML`, `getRelayoutBoundary`, `getSearchResults`, `hideHighlight` (redirect), `highlightNode` (redirect), `highlightRect` (redirect), `markUndoableState`, `moveTo`, `performSearch`, `pushNodeByPathToFrontend`, `pushNodesByBackendIdsToFrontend`, `querySelector`, `querySelectorAll`, `getTopLayerElements`, `getElementByRelation`, `redo`, `removeAttribute`, `removeNode`, `requestChildNodes`, `requestNode`, `resolveNode`, `setAttributeValue`, `setAttributesAsText`, `setFileInputFiles`, `setNodeStackTracesEnabled`, `getNodeStackTraces`, `getFileInfo`, `getDetachedDomNodes`, `setInspectedNode`, `setNodeName`, `setNodeValue`, `setOuterHTML`, `undo`, `getFrameOwner`, `getContainerForNode`, `getQueryingDescendantsForContainer`, `getAnchorElement`, `forceShowPopover`
- **Events:** `attributeModified`, `adoptedStyleSheetsModified`, `attributeRemoved`, `characterDataModified`, `childNodeCountUpdated`, `childNodeInserted`, `childNodeRemoved`, `distributedNodesUpdated`, `documentUpdated`, `inlineStyleInvalidated`, `pseudoElementAdded`, `topLayerElementsUpdated`, `scrollableFlagUpdated`, `adRelatedStateUpdated`, `affectedByStartingStylesFlagUpdated`, `pseudoElementRemoved`, `setChildNodes`, `shadowRootPopped`, `shadowRootPushed`
- **Types:** `NodeId`, `BackendNodeId`, `StyleSheetId`, `BackendNode`, `PseudoType`, `ShadowRootType`, `CompatibilityMode`, `PhysicalAxes`, `LogicalAxes`, `ScrollOrientation`, `Node`, `DetachedElementInfo`, `RGBA`, `Quad`, `BoxModel`, `ShapeOutsideInfo`, `Rect`, `CSSComputedStyleProperty`

### DOMSnapshot

Efficient snapshot of DOM, layout, and computed style for a document. Optimized for performance analysis.

- **Methods:** `disable`, `enable`, `getSnapshot` (deprecated), `captureSnapshot`
- **Events:** none
- **Types:** `DOMNode`, `InlineTextBox`, `LayoutTreeNode`, `ComputedStyle`, `NameValue`, `StringIndex`, `ArrayOfStrings`, `RareStringData`, `RareBooleanData`, `RareIntegerData`, `Rectangle`, `DocumentSnapshot`, `NodeTreeSnapshot`, `LayoutTreeSnapshot`, `TextBoxSnapshot`

### DOMDebugger

Set breakpoints on DOM events, XHRs, CSP violations, and DOM mutations.

- **Methods:** `getEventListeners`, `removeDOMBreakpoint`, `removeEventListenerBreakpoint`, `removeInstrumentationBreakpoint` (deprecated/redirect), `removeXHRBreakpoint`, `setBreakOnCSPViolation`, `setDOMBreakpoint`, `setEventListenerBreakpoint`, `setInstrumentationBreakpoint` (deprecated/redirect), `setXHRBreakpoint`
- **Events:** none
- **Types:** `DOMBreakpointType`, `CSPViolationType`, `EventListener`

### DOMStorage

Query and modify localStorage and sessionStorage.

- **Methods:** `clear`, `disable`, `enable`, `getDOMStorageItems`, `removeDOMStorageItem`, `setDOMStorageItem`
- **Events:** `domStorageItemAdded`, `domStorageItemRemoved`, `domStorageItemUpdated`, `domStorageItemsCleared`
- **Types:** `SerializedStorageKey`, `StorageId`, `Item`

### CSS

CSS read/write — inspect stylesheets, rules, computed styles, fonts, and media queries.

- **Methods:** `addRule`, `collectClassNames`, `createStyleSheet`, `disable`, `enable`, `forcePseudoState`, `forceStartingStyle`, `getBackgroundColors`, `getComputedStyleForNode`, `resolveValues`, `getLonghandProperties`, `getInlineStylesForNode`, `getAnimatedStylesForNode`, `getMatchedStylesForNode`, `getEnvironmentVariables`, `getMediaQueries`, `getPlatformFontsForNode`, `getStyleSheetText`, `getLayersForNode`, `getLocationForSelector`, `trackComputedStyleUpdatesForNode`, `trackComputedStyleUpdates`, `takeComputedStyleUpdates`, `setEffectivePropertyValueForNode`, `setPropertyRulePropertyName`, `setKeyframeKey`, `setMediaText`, `setContainerQueryText` (deprecated), `setContainerQueryConditionText`, `setSupportsText`, `setNavigationText`, `setScopeText`, `setRuleSelector`, `setStyleSheetText`, `setStyleTexts`, `startRuleUsageTracking`, `stopRuleUsageTracking`, `takeCoverageDelta`, `setLocalFontsEnabled`
- **Events:** `fontsUpdated`, `mediaQueryResultChanged`, `styleSheetAdded`, `styleSheetChanged`, `styleSheetRemoved`, `computedStyleUpdated`
- **Types:** `StyleSheetOrigin`, `PseudoElementMatches`, `CSSAnimationStyle`, `InheritedStyleEntry`, `InheritedAnimatedStyleEntry`, `InheritedPseudoElementMatches`, `RuleMatch`, `Value`, `SpecificityComponent`, `Specificity`, `SelectorList`, `CSSStyleSheetHeader`, `CSSRule`, `CSSRuleType`, `RuleUsage`, `SourceRange`, `ShorthandEntry`, `CSSComputedStyleProperty`, `ComputedStyleExtraFields`, `CSSStyle`, `CSSProperty`, `CSSMedia`, `MediaQuery`, `MediaQueryExpression`, `CSSContainerQuery`, `CSSSupports`, `CSSNavigation`, `CSSScope`, `CSSLayer`, `CSSStartingStyle`, `CSSLayerData`, `PlatformFontUsage`, `FontVariationAxis`, `FontFace`, `CSSTryRule`, `CSSPositionTryRule`, `CSSKeyframesRule`, `CSSPropertyRegistration`, `CSSAtRule`, `CSSPropertyRule`, `CSSFunctionParameter`, `CSSFunctionConditionNode`, `CSSFunctionNode`, `CSSFunctionRule`, `CSSKeyframeRule`, `StyleDeclarationEdit`

### Overlay

Drawing overlays atop the inspected page — highlights, grid/flex overlays, inspect mode, screenshots.

- **Methods:** `disable`, `enable`, `getHighlightObjectForTest`, `getGridHighlightObjectsForTest`, `getSourceOrderHighlightObjectForTest`, `hideHighlight`, `highlightFrame` (deprecated), `highlightNode`, `highlightQuad`, `highlightRect`, `highlightSourceOrder`, `setInspectMode`, `setShowAdHighlights`, `setPausedInDebuggerMessage`, `setShowDebugBorders`, `setShowFPSCounter`, `setShowGridOverlays`, `setShowFlexOverlays`, `setShowScrollSnapOverlays`, `setShowContainerQueryOverlays`, `setShowInspectedElementAnchor`, `setShowPaintRects`, `setShowLayoutShiftRegions`, `setShowScrollBottleneckRects`, `setShowHitTestBorders` (deprecated), `setShowWebVitals` (deprecated), `setShowViewportSizeOnResize`, `setShowHinge`, `setShowDisplayCutout`, `setShowIsolatedElements`, `setShowWindowControlsOverlay`
- **Events:** `inspectNodeRequested`, `nodeHighlightRequested`, `screenshotRequested`, `inspectPanelShowRequested`, `inspectedElementWindowRestored`, `inspectModeCanceled`
- **Types:** `SourceOrderConfig`, `GridHighlightConfig`, `FlexContainerHighlightConfig`, `FlexItemHighlightConfig`, `LineStyle`, `BoxStyle`, `ContrastAlgorithm`, `HighlightConfig`, `ColorFormat`, `GridNodeHighlightConfig`, `FlexNodeHighlightConfig`, `ScrollSnapContainerHighlightConfig`, `ScrollSnapHighlightConfig`, `HingeConfig`, `DisplayCutoutShape`, `DisplayCutoutConfig`, `WindowControlsOverlayConfig`, `ContainerQueryHighlightConfig`, `ContainerQueryContainerHighlightConfig`, `IsolatedElementHighlightConfig`, `IsolationModeHighlightConfig`, `InspectMode`, `InspectedElementAnchorConfig`

### LayerTree

Compositing layer inspection — paint profiling, layer snapshotting, compositing reasons.

- **Methods:** `compositingReasons`, `disable`, `enable`, `loadSnapshot`, `makeSnapshot`, `profileSnapshot`, `releaseSnapshot`, `replaySnapshot`, `snapshotCommandLog`
- **Events:** `layerPainted`, `layerTreeDidChange`
- **Types:** `LayerId`, `SnapshotId`, `ScrollRect`, `StickyPositionConstraint`, `PictureTile`, `Layer`, `PaintProfile`

---

## Network

### Network

Track network activities: HTTP requests/responses, cookies, caching, WebSockets, signed exchanges, throttling.

- **Methods:** `setAcceptedEncodings`, `clearAcceptedEncodingsOverride`, `canClearBrowserCache` (deprecated), `canClearBrowserCookies` (deprecated), `canEmulateNetworkConditions` (deprecated), `clearBrowserCache`, `clearBrowserCookies`, `continueInterceptedRequest` (deprecated), `deleteCookies`, `disable`, `emulateNetworkConditions` (deprecated), `emulateNetworkConditionsByRule`, `overrideNetworkState`, `enable`, `configureDurableMessages`, `getAllCookies` (deprecated), `getCertificate`, `getCookies`, `getResponseBody`, `getRequestPostData`, `getResponseBodyForInterception`, `takeResponseBodyForInterceptionAsStream`, `replayXHR`, `searchInResponseBody`, `setBlockedURLs`, `setBypassServiceWorker`, `setCacheDisabled`, `setCookie`, `setCookies`, `setDataSizeLimitsForTest`, `setExtraHTTPHeaders`, `setAttachDebugStack`, `getSecurityIsolationStatus`, `enableReportingApi`, `loadNetworkResource`, `setRequestInterception` (deprecated)
- **Events:** `dataReceived`, `eventSourceMessageReceived`, `loadingFailed`, `loadingFinished`, `requestIntercepted` (deprecated), `requestServedFromCache`, `requestWillBeSent`, `requestWillBeSentExtraInfo`, `responseReceived`, `responseReceivedExtraInfo`, `responseReceivedEarlyHints`, `signedExchangeReceived`, `subresourceWebBundleInnerResponseError`, `subresourceWebBundleMetadataError`, `subresourceWebBundleMetadataReceived`, `subresourceWebBundleInnerResponseParsed`, `webSocketClosed`, `webSocketCreated`, `webSocketFrameError`, `webSocketFrameReceived`, `webSocketFrameSent`, `webSocketHandshakeResponseReceived`, `webSocketWillSendHandshakeRequest`, `reportingReportAdded`, `reportingReportUpdated`, `cookiesChanged`
- **Types:** `ResourceType`, `LoaderId`, `RequestId`, `InterceptionId`, `ErrorReason`, `TimeSinceEpoch`, `MonotonicTime`, `Headers`, `ConnectionType`, `CookieSameSite`, `CookiePriority`, `CookieSourceScheme`, `ResourceTiming`, `ResourcePriority`, `RenderBlockingBehavior`, `PostDataEntry`, `Request`, `SignedCertificateTimestamp`, `SecurityDetails`, `CertificateTransparencyCompliance`, `BlockedReason`, `CorsError`, `CorsErrorStatus`, `ServiceWorkerResponseSource`, `TrustTokenParams`, `TrustTokenOperationType`, `AlternateProtocolUsage`, `ServiceWorkerRouterSource`, `ServiceWorkerRouterInfo`, `Response`, `WebSocketRequest`, `WebSocketResponse`, `WebSocketFrame`, `CachedResource`, `Initiator`, `CookiePartitionKey`, `Cookie`, `SetCookieBlockedReason`, `CookieBlockedReason`, `CookieExemptionReason`, `BlockedSetCookieWithReason`, `ExemptedSetCookieWithReason`, `AssociatedCookie`, `CookieParam`, `AuthChallenge`, `AuthChallengeResponse`, `InterceptionStage`, `RequestPattern`, `SignedExchangeSignature`, `SignedExchangeHeader`, `SignedExchangeErrorField`, `SignedExchangeError`, `SignedExchangeInfo`, `ContentEncoding`, `NetworkConditions`, `BlockPattern`, `ConnectTiming`, `AdAncestry`, `AdProvenance`, `ClientSecurityState`, `IPAddressSpace`, `CrossOriginOpenerPolicyStatus`, `CrossOriginEmbedderPolicyStatus`, `SecurityIsolationStatus`, `ReportBody`, `Report`

### Fetch

Intercept and modify network requests. Replaces the deprecated `Network.requestIntercepted` pattern.

- **Methods:** `disable`, `enable`, `failRequest`, `fulfillRequest`, `continueRequest`, `continueWithAuth`, `continueResponse`, `getResponseBody`, `takeResponseBodyAsStream`
- **Events:** `requestPaused`, `authRequired`
- **Types:** `RequestId`, `RequestStage`, `RequestPattern`, `HeaderEntry`, `AuthChallenge`, `AuthChallengeResponse`

### CacheStorage

Read Cache Storage API data.

- **Methods:** `deleteCache`, `deleteEntry`, `requestCacheNames`, `requestCachedResponse`, `requestEntries`
- **Events:** none
- **Types:** `CacheId`, `CachedResponseType`, `DataEntry`, `Cache`, `Header`, `CachedResponse`

### BackgroundService

Observe background web platform services: background fetch, sync, push, notifications, payment handler.

- **Methods:** `startObserving`, `stopObserving`, `setRecording`, `clearEvents`
- **Events:** `recordingStateChanged`, `backgroundServiceEventReceived`
- **Types:** `ServiceName`, `EventMetadata`, `BackgroundServiceEvent`

### Preload

Track speculation rules, prefetching, and prerendering. Observes the Speculation Rules API.

- **Methods:** `enable`, `disable`
- **Events:** `ruleSetUpdated`, `ruleSetRemoved`, `preloadEnabledStateUpdated`, `prefetchStatusUpdated`, `prerenderStatusUpdated`, `preloadingAttemptSourcesUpdated`
- **Types:** `RuleSetId`, `RuleSet`, `RuleSetErrorType`, `SpeculationAction`, `SpeculationTargetHint`, `PreloadingAttemptKey`, `PreloadingAttemptSource`, `PreloadPipelineId`, `PrerenderFinalStatus`, `PreloadingStatus`, `PrefetchStatus`, `PrerenderMismatchedHeaders`

---

## JavaScript Runtime

### Runtime

JavaScript runtime mirror — evaluate expressions, inspect objects, manage execution contexts.

- **Methods:** `awaitPromise`, `callFunctionOn`, `compileScript`, `disable`, `discardConsoleEntries`, `enable`, `evaluate`, `getExceptionDetails`, `getHeapUsage`, `getIsolateId`, `getProperties`, `globalLexicalScopeNames`, `queryObjects`, `releaseObject`, `releaseObjectGroup`, `runIfWaitingForDebugger`, `runScript`, `setAsyncCallStackDepth`, `setCustomObjectFormatterEnabled`, `setMaxCallStackSizeToCapture`, `terminateExecution`, `addBinding`, `removeBinding`, `getBindingName`, `getObjectProperty`
- **Events:** `bindingCalled`, `consoleAPICalled`, `exceptionRevoked`, `exceptionThrown`, `executionContextCreated`, `executionContextDestroyed`, `executionContextsCleared`, `inspectRequested`
- **Types:** `ScriptId`, `SerializationOptions`, `DeepSerializedValue`, `RemoteObjectId`, `UnserializableValue`, `RemoteObject`, `CustomPreview`, `ObjectPreview`, `PropertyPreview`, `EntryPreview`, `PropertyDescriptor`, `InternalPropertyDescriptor`, `PrivatePropertyDescriptor`, `CallArgument`, `ExecutionContextId`, `ExecutionContextDescription`, `ExceptionDetails`, `Timestamp`, `TimeDelta`, `CallFrame`, `StackTraceId`, `StackTrace`, `UniqueDebuggerId`, `ObjectPreview`, `PropertyPreview`, `EntryPreview`

### Debugger

JavaScript debugging — breakpoints, stepping, call stacks, script inspection.

- **Methods:** `continueToLocation`, `disable`, `enable`, `evaluateOnCallFrame`, `getPossibleBreakpoints`, `getScriptSource`, `disassembleWasmModule`, `nextWasmDisassemblyChunk`, `getWasmBytecode` (deprecated), `getStackTrace`, `pause`, `pauseOnAsyncCall` (deprecated), `removeBreakpoint`, `restartFrame`, `resume`, `searchInContent`, `setAsyncCallStackDepth`, `setBlackboxExecutionContexts`, `setBlackboxPatterns`, `setBlackboxedRanges`, `setBreakpoint`, `setInstrumentationBreakpoint`, `setBreakpointByUrl`, `setBreakpointOnFunctionCall`, `setBreakpointsActive`, `setPauseOnExceptions`, `setReturnValue`, `setScriptSource`, `setSkipAllPauses`, `setVariableValue`, `stepInto`, `stepOut`, `stepOver`
- **Events:** `breakpointResolved` (deprecated), `paused`, `resumed`, `scriptFailedToParse`, `scriptParsed`
- **Types:** `BreakpointId`, `CallFrameId`, `Location`, `ScriptPosition`, `LocationRange`, `CallFrame`, `Scope`, `SearchMatch`, `BreakLocation`, `ScriptLanguage`, `DebugSymbols`, `ResolvedBreakpoint`, `WasmDisassemblyChunk`

### Console (deprecated)

Console message collection. Deprecated — use `Runtime.consoleAPICalled` or `Log` domain instead.

- **Methods:** `clearMessages`, `disable`, `enable`
- **Events:** `messageAdded`
- **Types:** `ConsoleMessage`

### HeapProfiler

Heap snapshot and sampling heap profiling.

- **Methods:** `addInspectedHeapObject`, `collectGarbage`, `disable`, `enable`, `getHeapObjectId`, `getObjectByHeapObjectId`, `getSamplingProfile`, `startSampling`, `startTrackingHeapObjects`, `stopSampling`, `stopTrackingHeapObjects`, `takeHeapSnapshot`
- **Events:** `addHeapSnapshotChunk`, `heapStatsUpdate`, `lastSeenObjectId`, `reportHeapSnapshotProgress`, `resetProfiles`
- **Types:** `HeapSnapshotObjectId`, `SamplingHeapProfileNode`, `SamplingHeapProfileSample`, `SamplingHeapProfile`

### Profiler

CPU profiler and code coverage.

- **Methods:** `disable`, `enable`, `getBestEffortCoverage`, `setSamplingInterval`, `start`, `startPreciseCoverage`, `stop`, `stopPreciseCoverage`, `takePreciseCoverage`
- **Events:** `consoleProfileFinished`, `consoleProfileStarted`, `preciseCoverageDeltaUpdate`
- **Types:** `ProfileNode`, `Profile`, `PositionTickInfo`, `CoverageRange`, `FunctionCoverage`, `ScriptCoverage`

---

## Performance

### Performance

Runtime performance metrics: timestamps, heap usage, document/node/frame counts.

- **Methods:** `disable`, `enable`, `setTimeDomain` (deprecated), `getMetrics`
- **Events:** `metrics`
- **Types:** `Metric`

### PerformanceTimeline

Performance observer timeline events: LCP, layout shifts, etc.

- **Methods:** `enable`
- **Events:** `timelineEventAdded`
- **Types:** `LargestContentfulPaint`, `LayoutShiftAttribution`, `LayoutShift`, `TimelineEvent`

### Memory

Memory pressure simulation, DOM counters, native memory sampling.

- **Methods:** `getDOMCounters`, `getDOMCountersForLeakDetection`, `prepareForLeakDetection`, `forciblyPurgeJavaScriptMemory`, `setPressureNotificationsSuppressed`, `simulatePressureNotification`, `startSampling`, `stopSampling`, `getAllTimeSamplingProfile`, `getBrowserSamplingProfile`, `getSamplingProfile`
- **Events:** none
- **Types:** `PressureLevel`, `SamplingProfileNode`, `SamplingProfile`, `Module`, `DOMCounter`

### Tracing

Chrome tracing infrastructure (Trace Events, Perfetto).

- **Methods:** `end`, `getCategories`, `getTrackEventDescriptor`, `recordClockSyncMarker`, `requestMemoryDump`, `start`
- **Events:** `bufferUsage`, `dataCollected`, `tracingComplete`
- **Types:** `MemoryDumpConfig`, `TraceConfig`, `StreamFormat`, `StreamCompression`, `MemoryDumpLevelOfDetail`, `TracingBackend`

---

## Input / Device

### Input

Dispatch mouse, keyboard, touch, and drag events to the page. Also includes gesture synthesis.

- **Methods:** `dispatchDragEvent`, `dispatchKeyEvent`, `insertText`, `imeSetComposition`, `dispatchMouseEvent`, `dispatchTouchEvent`, `cancelDragging`, `emulateTouchFromMouseEvent`, `setIgnoreInputEvents`, `setInterceptDrags`, `synthesizePinchGesture`, `synthesizeScrollGesture`, `synthesizeTapGesture`
- **Events:** `dragIntercepted`
- **Types:** `TouchPoint`, `GestureSourceType`, `MouseButton`, `TimeSinceEpoch`, `DragDataItem`, `DragData`

### Emulation

Emulate device metrics, user agent, geolocation, sensors, timezone, locale, virtual time, screen configuration.

- **Methods:** `canEmulate` (deprecated), `clearDeviceMetricsOverride`, `clearGeolocationOverride`, `resetPageScaleFactor`, `setFocusEmulationEnabled`, `setAutoDarkModeOverride`, `setCPUThrottlingRate`, `setDefaultBackgroundColorOverride`, `setSafeAreaInsetsOverride`, `setDeviceMetricsOverride`, `setDevicePostureOverride`, `clearDevicePostureOverride`, `setDisplayFeaturesOverride`, `clearDisplayFeaturesOverride`, `setScrollbarsHidden`, `setDocumentCookieDisabled`, `setEmitTouchEventsForMouse`, `setEmulatedMedia`, `setEmulatedVisionDeficiency`, `setEmulatedOSTextScale`, `setGeolocationOverride`, `getOverriddenSensorInformation`, `setSensorOverrideEnabled`, `setSensorOverrideReadings`, `setPressureSourceOverrideEnabled`, `setPressureStateOverride`, `setIdleOverride`, `clearIdleOverride`, `setNavigatorOverrides` (deprecated), `setPageScaleFactor`, `setScriptExecutionDisabled`, `setTouchEmulationEnabled`, `setVirtualTimePolicy`, `setLocaleOverride`, `setTimezoneOverride`, `setVisibleSize` (deprecated), `setDisabledImageTypes`, `setDataSaverOverride`, `setHardwareConcurrencyOverride`, `setUserAgentOverride`, `setAutomationOverride`, `setSmallViewportHeightDifferenceOverride`, `getScreenInfos`, `addScreen`, `updateScreen`, `removeScreen`, `setPrimaryScreen`
- **Events:** `virtualTimeBudgetExpired`, `screenOrientationLockChanged`
- **Types:** `SafeAreaInsets`, `ScreenOrientation`, `DisplayFeature`, `DevicePosture`, `MediaFeature`, `VirtualTimePolicy`, `UserAgentBrandVersion`, `UserAgentMetadata`, `SensorType`, `SensorMetadata`, `SensorReadingSingle`, `SensorReadingXYZ`, `SensorReadingQuaternion`, `SensorReading`, `PressureSource`, `PressureState`, `PressureMetadata`, `WorkAreaInsets`, `ScreenId`, `ScreenInfo`, `DisabledImageType`

### DeviceOrientation

Override device orientation (alpha, beta, gamma).

- **Methods:** `clearDeviceOrientationOverride`, `setDeviceOrientationOverride`
- **Events:** none
- **Types:** none

### DeviceAccess

Handle device selection prompts (e.g., WebUSB, Web Bluetooth).

- **Methods:** `enable`, `disable`, `selectPrompt`, `cancelPrompt`
- **Events:** `deviceRequestPrompted`
- **Types:** `RequestId`, `DeviceId`, `PromptDevice`

### BluetoothEmulation

Simulate Bluetooth peripherals for testing the Web Bluetooth API.

- **Methods:** `enable`, `setSimulatedCentralState`, `disable`, `simulatePreconnectedPeripheral`, `simulateAdvertisement`, `simulateGATTOperationResponse`, `simulateCharacteristicOperationResponse`, `simulateDescriptorOperationResponse`, `addService`, `removeService`, `addCharacteristic`, `removeCharacteristic`, `addDescriptor`, `removeDescriptor`, `simulateGATTDisconnection`
- **Events:** `gattOperationReceived`, `characteristicOperationReceived`, `descriptorOperationReceived`
- **Types:** `CentralState`, `GATTOperationType`, `CharacteristicWriteType`, `CharacteristicOperationType`, `DescriptorOperationType`, `ManufacturerData`, `ScanRecord`, `ScanEntry`, `CharacteristicProperties`

### SmartCardEmulation

Simulate PC/SC smart card readers and cards for testing Web Smart Card API.

- **Methods:** `enable`, `disable`, `reportEstablishContextResult`, `reportReleaseContextResult`, `reportListReadersResult`, `reportGetStatusChangeResult`, `reportBeginTransactionResult`, `reportPlainResult`, `reportConnectResult`, `reportDataResult`, `reportStatusResult`, `reportError`
- **Events:** `establishContextRequested`, `releaseContextRequested`, `listReadersRequested`, `getStatusChangeRequested`, `cancelRequested`, `connectRequested`, `disconnectRequested`, `transmitRequested`, `controlRequested`, `getAttribRequested`, `setAttribRequested`, `statusRequested`, `beginTransactionRequested`, `endTransactionRequested`
- **Types:** `ResultCode`, `ShareMode`, `Disposition`, `ConnectionState`, `ReaderStateFlags`, `ProtocolSet`, `Protocol`, `ReaderStateIn`, `ReaderStateOut`

---

## Audio / Media

### WebAudio

Inspect Web Audio API graph: AudioContexts, AudioNodes, AudioParams, connections.

- **Methods:** `enable`, `disable`, `getRealtimeData`
- **Events:** `contextCreated`, `contextWillBeDestroyed`, `contextChanged`, `audioListenerCreated`, `audioListenerWillBeDestroyed`, `audioNodeCreated`, `audioNodeWillBeDestroyed`, `audioParamCreated`, `audioParamWillBeDestroyed`, `nodesConnected`, `nodesDisconnected`, `nodeParamConnected`, `nodeParamDisconnected`
- **Types:** `GraphObjectId`, `ContextType`, `ContextState`, `NodeType`, `ChannelCountMode`, `ChannelInterpretation`, `ParamType`, `AutomationRate`, `ContextRealtimeData`, `BaseAudioContext`, `AudioListener`, `AudioNode`, `AudioParam`

### Media

Inspect media element playback: players, events, properties, messages, errors.

- **Methods:** `enable`, `disable`
- **Events:** `playerPropertiesChanged`, `playerEventsAdded`, `playerMessagesLogged`, `playerErrorsRaised`, `playerCreated`
- **Types:** `PlayerId`, `Timestamp`, `PlayerMessage`, `PlayerProperty`, `PlayerEvent`, `PlayerErrorSourceLocation`, `PlayerError`, `Player`

### Animation

Inspect and control CSS animations, CSS transitions, and Web Animations.

- **Methods:** `disable`, `enable`, `getCurrentTime`, `getPlaybackRate`, `releaseAnimations`, `resolveAnimation`, `seekAnimations`, `setPaused`, `setPlaybackRate`, `setTiming`
- **Events:** `animationCanceled`, `animationCreated`, `animationStarted`, `animationUpdated`
- **Types:** `Animation`, `ViewOrScrollTimeline`, `AnimationEffect`, `KeyframesRule`, `KeyframeStyle`

---

## Web Platform

### WebAuthn

Test WebAuthn API by configuring virtual authenticators (U2F, CTAP2) with configurable transports, credentials, and user verification.

- **Methods:** `enable`, `disable`, `addVirtualAuthenticator`, `setResponseOverrideBits`, `removeVirtualAuthenticator`, `addCredential`, `getCredential`, `getCredentials`, `removeCredential`, `clearCredentials`, `setUserVerified`, `setAutomaticPresenceSimulation`, `setCredentialProperties`
- **Events:** `credentialAdded`, `credentialDeleted`, `credentialUpdated`, `credentialAsserted`
- **Types:** `AuthenticatorId`, `AuthenticatorProtocol`, `Ctap2Version`, `AuthenticatorTransport`, `VirtualAuthenticatorOptions`, `Credential`

### FedCm

Interact with FedCM (Federated Credential Management) dialogs.

- **Methods:** `enable`, `disable`, `selectAccount`, `clickDialogButton`, `openUrl`, `dismissDialog`, `resetCooldown`
- **Events:** `dialogShown`, `dialogClosed`
- **Types:** `LoginState`, `DialogType`, `DialogButton`, `AccountUrlType`, `Account`

### PWA

Install, launch, and manage Progressive Web Apps.

- **Methods:** `getOsAppState`, `install`, `uninstall`, `launch`, `launchFilesInApp`, `openCurrentPageInApp`, `changeAppUserSettings`
- **Events:** none
- **Types:** `FileHandlerAccept`, `FileHandler`, `DisplayMode`

### Extensions

Manage browser extensions: load unpacked, inspect storage, trigger actions.

- **Methods:** `triggerAction`, `loadUnpacked`, `getExtensions`, `uninstall`, `getStorageItems`, `removeStorageItems`, `clearStorageItems`, `setStorageItems`
- **Events:** none
- **Types:** `StorageArea`, `ExtensionInfo`

### Autofill

Trigger form autofill with specific address/credit card data for testing.

- **Methods:** `trigger`, `setAddresses`, `disable`, `enable`
- **Events:** `addressFormFilled`
- **Types:** `CreditCard`, `AddressField`, `AddressFields`, `Address`, `AddressUI`, `FillingStrategy`, `FilledField`

### FileSystem

Read directory and file listings from origin-bound file systems (OPFS / bucket file systems).

- **Methods:** `getDirectory`
- **Events:** none
- **Types:** `File`, `Directory`, `BucketFileSystemLocator`

### IndexedDB

Inspect IndexedDB databases, object stores, and entries.

- **Methods:** `clearObjectStore`, `deleteDatabase`, `deleteObjectStoreEntries`, `disable`, `enable`, `requestData`, `getMetadata`, `requestDatabase`, `requestDatabaseNames`
- **Events:** none
- **Types:** `DatabaseWithObjectStores`, `ObjectStore`, `ObjectStoreIndex`, `Key`, `KeyRange`, `DataEntry`, `KeyPath`

### WebMCP

MCP (Model Context Protocol) integration in the browser — tool registration and invocation for on-device AI.

- **Methods:** `enable`, `disable`, `invokeTool`, `cancelInvocation`
- **Events:** `toolsAdded`, `toolsRemoved`, `toolInvoked`, `toolResponded`
- **Types:** `Annotation`, `InvocationStatus`, `Tool`, `RemovedTool`

---

## Security

### Audits

Investigate page violations: cookie issues, mixed content, CSP violations, heavy ads, CORS, generic issues, deprecations.

- **Methods:** `getEncodedResponse`, `disable`, `enable`, `checkFormsIssues`
- **Events:** `issueAdded`
- **Types:** `AffectedCookie`, `AffectedRequest`, `AffectedFrame`, `CookieExclusionReason`, `CookieWarningReason`, `CookieOperation`, `InsightType`, `CookieIssueInsight`, `CookieIssueDetails`, `PerformanceIssueType`, `PerformanceIssueDetails`, `MixedContentResolutionStatus`, `MixedContentResourceType`, `MixedContentIssueDetails`, `BlockedByResponseReason`, `BlockedByResponseIssueDetails`, `HeavyAdResolutionStatus`, `HeavyAdReason`, `HeavyAdIssueDetails`, `ContentSecurityPolicyViolationType`, `SourceCodeLocation`, `ContentSecurityPolicyIssueDetails`, `SharedArrayBufferIssueType`, `SharedArrayBufferIssueDetails`, `CorsIssueDetails`, `AttributionReportingIssueType`, `SharedDictionaryError`, `SRIMessageSignatureError`, `UnencodedDigestError`, `ConnectionAllowlistError`, `AttributionReportingIssueDetails`, `QuirksModeIssueDetails`, `NavigatorUserAgentIssueDetails` (deprecated), `SharedDictionaryIssueDetails`, `SRIMessageSignatureIssueDetails`, `UnencodedDigestIssueDetails`, `ConnectionAllowlistIssueDetails`, `GenericIssueErrorType`, `GenericIssueDetails`, `DeprecationIssueDetails`, `BounceTrackingIssueDetails`, `CookieDeprecationMetadataIssueDetails`, `ClientHintIssueReason`, `FederatedAuthRequestIssueDetails`, `FederatedAuthRequestIssueReason`, `FederatedAuthUserInfoRequestIssueDetails`, `FederatedAuthUserInfoRequestIssueReason`, `EmailVerificationRequestIssueDetails`, `EmailVerificationRequestIssueReason`, `ClientHintIssueDetails`, `FailedRequestInfo`, `PartitioningBlobURLInfo`, `PartitioningBlobURLIssueDetails`, `ElementAccessibilityIssueReason`, `ElementAccessibilityIssueDetails`, `StyleSheetLoadingIssueReason`, `StylesheetLoadingIssueDetails`, `PropertyRuleIssueReason`, `PropertyRuleIssueDetails`, `UserReidentificationIssueType`, `UserReidentificationIssueDetails`, `PermissionElementIssueType`, `PermissionElementIssueDetails`, `SelectivePermissionsInterventionIssueDetails`, `InspectorIssueCode`, `InspectorIssueDetails`, `IssueId`, `InspectorIssue`

### Ads

Ad-related metrics: ad frame data, viewport ad density, ad CPU/network usage.

- **Methods:** `getAdMetrics`
- **Events:** none
- **Types:** `AdFrameData`, `AdMetrics`

### CrashReportContext

Read CrashReportContext API entries across all frames.

- **Methods:** `getEntries`
- **Events:** none
- **Types:** `CrashReportContextEntry`

---

## Other

### Log

Access browser console logs with timestamps, sources, and stack traces.

- **Methods:** `clear`, `disable`, `enable`, `startViolationsReport`, `stopViolationsReport`
- **Events:** `entryAdded`
- **Types:** `LogEntry`, `ViolationSetting`

### Inspector

Low-level inspector lifecycle events (detach, crash, worker script loaded).

- **Methods:** `disable`, `enable`
- **Events:** `detached`, `targetCrashed`, `targetReloadedAfterCrash`, `workerScriptLoaded`
- **Types:** none

### Schema

Currently not defined in the PDL (legacy domain). Previously exposed available domains.

### Tethering

Bind browser ports for remote debugging through the DevTools protocol.

- **Methods:** `bind`, `unbind`
- **Events:** `accepted`
- **Types:** none

### Cast

Interact with Cast, Presentation API, and Remote Playback API — list sinks, start/stop mirroring.

- **Methods:** `enable`, `disable`, `setSinkToUse`, `startDesktopMirroring`, `startTabMirroring`, `stopCasting`
- **Events:** `sinksUpdated`, `issueUpdated`
- **Types:** `Sink`

### HeadlessExperimental

Headless-specific rendering control — BeginFrame, screenshot capture.

- **Methods:** `beginFrame`, `disable` (deprecated), `enable` (deprecated)
- **Events:** none
- **Types:** `ScreenshotParams`

### EventBreakpoints

Set breakpoints on native events (formerly part of DOMDebugger). Instrumentation breakpoints for native code.

- **Methods:** `setInstrumentationBreakpoint`, `removeInstrumentationBreakpoint`, `disable`
- **Events:** none
- **Types:** none

### DigitalCredentials

Automate Digital Credentials API (e.g., OpenID4VP) with a virtual wallet.

- **Methods:** `setVirtualWalletBehavior`
- **Events:** none
- **Types:** `VirtualWalletAction`

### ServiceWorker

Manage ServiceWorker registrations, versions, and debug lifecycle.

- **Methods:** `deliverPushMessage`, `disable`, `dispatchSyncEvent`, `dispatchPeriodicSyncEvent`, `enable`, `setForceUpdateOnPageLoad`, `skipWaiting`, `startWorker`, `stopAllWorkers`, `stopWorker`, `unregister`, `updateRegistration`
- **Events:** `workerErrorReported`, `workerRegistrationUpdated`, `workerVersionUpdated`
- **Types:** `RegistrationID`, `ServiceWorkerRegistration`, `ServiceWorkerVersionRunningStatus`, `ServiceWorkerVersionStatus`, `ServiceWorkerVersion`, `ServiceWorkerErrorMessage`

### Accessibility

Read accessibility tree: AX nodes, properties, relations, roles.

- **Methods:** `disable`, `enable`, `getPartialAXTree`, `getFullAXTree`, `getRootAXNode`, `getAXNodeAndAncestors`, `getChildAXNodes`, `queryAXTree`
- **Events:** `loadComplete`, `nodesUpdated`
- **Types:** `AXNodeId`, `AXValueType`, `AXValueSourceType`, `AXValueNativeSourceType`, `AXValueSource`, `AXRelatedNode`, `AXProperty`, `AXValue`, `AXPropertyName`, `AXNode`
