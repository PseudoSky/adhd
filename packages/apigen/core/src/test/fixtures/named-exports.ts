export async function getUser(userId: string): Promise<{ id: string; name: string }> {
  return { id: userId, name: 'test' }
}

export const sendEmail = async (to: string, subject: string, body?: string): Promise<void> => {}

export const VERSION = '1.0.0'  // should be ignored
