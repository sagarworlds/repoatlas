export function helper(text: string): string {
  return text.trim();
}

export const shout = async (text: string): Promise<string> => text.toUpperCase();
