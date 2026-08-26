// Fixture: streaming class-method return types for extract-classes.spec.ts
// (SPEC §10, §11).
//
// StreamingService members:
//   Static:
//     - StreamingService.streamStatic(): AsyncGenerator<{ n: number }>
//       (static — must be streaming:true, output = the chunk shape)
//   Instance (opt-in):
//     - streamInstance(): AsyncGenerator<{ label: string }>
//       (instance method — must be streaming:true)
//     - getValue(): Promise<{ value: number }>
//       (regression control — must remain streaming:false)

export class StreamingService {
  private value = 0;

  static async *streamStatic(): AsyncGenerator<{ n: number }> {
    yield { n: 1 };
    yield { n: 2 };
  }

  async *streamInstance(): AsyncGenerator<{ label: string }> {
    yield { label: 'a' };
  }

  async getValue(): Promise<{ value: number }> {
    return { value: this.value };
  }
}
