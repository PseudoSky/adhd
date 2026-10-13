/**
 * @adhd/stealth-browser — src/lib/recording/memory-sink.ts
 *
 * In-memory `RecordingSink`: the reference implementation of the sink
 * contract, the default for quick scripts and the test double for everything
 * else. Idempotent by envelope key; records come back in `seq` order.
 *
 * Ticket 8468f7b1 · plan state capture-upgrade [capture-upgrade.15].
 */
import type { RecordingEnvelope, RecordingSink } from './types.js'

export class MemoryRecordingSink implements RecordingSink {
  private readonly byKey = new Map<string, RecordingEnvelope>()
  private closed = false

  /** Replaying an envelope with a known key replaces it: one record per key. */
  write(envelope: RecordingEnvelope): void {
    if (this.closed) throw new Error('MemoryRecordingSink is closed')
    this.byKey.set(envelope.key, envelope)
  }

  /** Stored envelopes in strictly increasing `seq` order. */
  records(): RecordingEnvelope[] {
    return [...this.byKey.values()].sort((a, b) => a.seq - b.seq)
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Idempotent. */
  close(): void {
    this.closed = true
  }
}
