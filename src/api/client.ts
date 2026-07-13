export async function apiRequest(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, init);
}

export async function readJson<T>(response: Response): Promise<T | Record<string, never>> {
  return response.json().catch(() => ({})) as Promise<T | Record<string, never>>;
}
