// Fixture: Shape 2 — named arrow/const export
// export const foo = (...) => ...

export const sendEmail = async (to: string, subject: string, body?: string): Promise<void> => {}

export const computeScore = (value: number, weight: number): number => value * weight
