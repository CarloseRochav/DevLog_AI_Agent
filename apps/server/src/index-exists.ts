export interface IndexLookup {
  getIndex(name: string): Promise<unknown>;
}

export async function indexExists(
  client: IndexLookup,
  name: string,
): Promise<boolean> {
  try {
    await client.getIndex(name);
    return true;
  } catch (error) {
    if (isMissingIndex(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingIndex(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as { statusCode?: unknown; status?: unknown };
  return record.statusCode === 404 || record.status === 404;
}
