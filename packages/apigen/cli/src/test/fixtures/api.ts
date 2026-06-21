export async function getUser(userId: string): Promise<{ id: string }> {
  return { id: userId }
}

export async function sendEmail(to: string, subject: string): Promise<void> {}

export const __samples__: Record<string, Record<string, unknown>> = {
  getUser: { userId: 'abc' },
  sendEmail: { to: 'a@b.com', subject: 'hi' },
}
