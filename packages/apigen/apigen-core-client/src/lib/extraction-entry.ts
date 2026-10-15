// extraction-entry.ts — the one IR-generation entry (ADR-0017 D5).
//
// `generate`, `run`, `serve` and the policy wrapper's baked artifact all turn a
// classified source reference into canonical `Operation[]` through this module.
// It owns three things the hosts used to each re-derive:
//
//  1. the extractor registry, keyed by `ExtractCall.host` (the translator id),
//     which IS the `runExtractor` terminal the extract-stage onion wraps;
//  2. the construction of the `ExtractCall`, from which the extractor's own
//     options are rebuilt — nothing that affects extraction lives in a closure,
//     so everything that affects extraction is part of an ir-cache key;
//  3. the composition of the `--use` plugins' `extractLayer` onion around the
//     registry terminal.

import * as path from 'node:path';
import type { Logger } from 'pino';
import type { Operation } from './descriptor';
import { extract } from './extract';
import type { ExtractionSession } from './extraction-session';
import {
  createExtractInvokerFromPlugins,
  sourceFilesOf,
  type ExtractCall,
  type ExtractResult,
} from './extract-invoker';
import type { Plugin } from './plugin';
import type { ISourceResolution } from './source-language';

/**
 * One translator: turns the source named by an {@link ExtractCall} into
 * canonical operations. It may report the files it read through
 * `withSourceFiles` (see {@link ExtractResult}).
 */
export type Extractor = (call: ExtractCall) => Promise<ExtractResult>;

/** Extractors keyed by `ExtractCall.host` (a `TranslatorId`). */
export interface ExtractorRegistry {
  /**
   * Register (or replace) the extractor for `host`.
   *
   * @param host      - The translator id, equal to `ExtractCall.host`.
   * @param extractor - The translator.
   */
  register(host: string, extractor: Extractor): void;
  /** The extractor registered for `host`, or `undefined`. */
  get(host: string): Extractor | undefined;
  /** The hosts that currently have an extractor, in registration order. */
  hosts(): string[];
}

/**
 * The TypeScript extractor. It builds `ExtractOptions` only from the call:
 * `source`, `namespace` and `extractorOptions.{dropFileSegment,tsconfig,session}`.
 */
const typescriptExtractor: Extractor = (call) => {
  const options = call.extractorOptions;
  const tsconfig = options?.['tsconfig'];
  const dropFileSegment = options?.['dropFileSegment'];
  return extract({
    sourceFile: call.source,
    namespace: call.namespace,
    tsconfig: typeof tsconfig === 'string' ? tsconfig : undefined,
    dropFileSegment:
      typeof dropFileSegment === 'boolean' ? dropFileSegment : undefined,
    session: options?.['session'] as ExtractionSession | undefined,
  });
};

/**
 * Create an extractor registry with the TypeScript extractor registered first
 * under `'ts'`. Other hosts (for example `argv` and `mcp`) register their
 * translators with {@link ExtractorRegistry.register}.
 *
 * @returns A fresh registry; registries are not shared between calls.
 */
export function createExtractorRegistry(): ExtractorRegistry {
  const extractors = new Map<string, Extractor>();
  extractors.set('ts', typescriptExtractor);
  return {
    register(host, extractor) {
      extractors.set(host, extractor);
    },
    get(host) {
      return extractors.get(host);
    },
    hosts() {
      return [...extractors.keys()];
    },
  };
}

/** What {@link extractSourceEntry} returns. */
export interface IExtractionResult {
  /** The canonical operations (IR) the source translates to. */
  operations: Operation[];
  /**
   * The files the extractor read to produce `operations` (the extraction
   * result's `sourceFiles`); empty when the extractor reports none.
   */
  files: string[];
}

/** Input to {@link extractSourceEntry}. */
export interface IExtractSourceEntryInput {
  /** The `--source` reference exactly as given. */
  reference: string;
  /** The classification of `reference` (from `resolveSourceReference`). */
  resolution: ISourceResolution;
  /** Namespace segment for the operations. */
  namespace?: string;
  /**
   * Explicit tsconfig path for the TS extractor, already resolved by the
   * caller. Travels in `extractorOptions` so it is part of any cache key.
   */
  tsconfig?: string;
  /**
   * Omit the file-derived path segment from every operation id (see
   * `ExtractOptions.dropFileSegment`). Travels in `extractorOptions`.
   */
  dropFileSegment?: boolean;
  /** The loaded `--use` plugins; their `extractLayer` capabilities wrap the extractor. */
  usePlugins: readonly Plugin[];
  /** This invocation's flat `--opt` bag, passed to each `extractLayer.createLayer`. */
  extractLayerOptions: Record<string, unknown>;
  /** Run-scoped extraction session shared by every source of the run. */
  session?: ExtractionSession;
  /** The extractor registry, keyed by translator id. */
  registry: ExtractorRegistry;
  /** Optional logger. */
  logger?: Logger;
}

/** Where an `ExtractCall` reads from, per the resolution's locator. */
function sourceOf(resolution: ISourceResolution): string {
  const { locator } = resolution;
  switch (locator.kind) {
    case 'path':
      return locator.path;
    case 'url':
      return locator.url;
    case 'command':
      return locator.command;
  }
}

/**
 * The single IR-generation entry. Builds the {@link ExtractCall} for a
 * classified source, composes the `--use` plugins' `extractLayer` onion around
 * the registry's extractor for `resolution.translator`, runs it, and returns
 * the operations together with the files the extractor read.
 *
 * Every extractor option travels in the `ExtractCall` (`source`, `namespace`,
 * `extractorOptions.{dropFileSegment,tsconfig,session}`), so a cache layer
 * keyed on the call sees everything that affects extraction.
 *
 * @param input - See {@link IExtractSourceEntryInput}.
 * @returns The operations and the files read.
 * @throws if the resolution has no translator, or no extractor is registered
 *         for it.
 */
export async function extractSourceEntry(
  input: IExtractSourceEntryInput
): Promise<IExtractionResult> {
  const {
    reference,
    resolution,
    namespace,
    tsconfig,
    dropFileSegment,
    usePlugins,
    extractLayerOptions,
    session,
    registry,
    logger,
  } = input;

  const host = resolution.translator;
  if (host === undefined) {
    throw new Error(
      `apigen-orchestrator: source "${reference}" names no translator; ` +
        `an executable source needs an explicit protocol`
    );
  }
  const extractor = registry.get(host);
  if (extractor === undefined) {
    throw new Error(`apigen-orchestrator: no ${host} extractor is registered`);
  }

  const extractorOptions: Record<string, unknown> = {};
  if (tsconfig !== undefined) extractorOptions['tsconfig'] = tsconfig;
  if (dropFileSegment !== undefined) {
    extractorOptions['dropFileSegment'] = dropFileSegment;
  }
  if (session !== undefined) extractorOptions['session'] = session;

  logger?.info(`extracting ${reference} (host: ${host}, ns: ${namespace})`);
  const invokeExtract = createExtractInvokerFromPlugins(
    usePlugins,
    extractor,
    extractLayerOptions
  );
  const operations = await invokeExtract({
    source: sourceOf(resolution),
    host,
    namespace,
    extractorOptions,
  });
  logger?.info(
    `extracted ${operations.length} operations from ${path.basename(reference)}`
  );
  logger?.debug({ ops: operations.map((o) => o.id) }, 'operation ids');
  return { operations, files: [...(sourceFilesOf(operations) ?? [])] };
}
