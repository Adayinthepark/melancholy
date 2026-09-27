export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      typeof data === "object" && data !== null && "error" in data
        ? String(data.error)
        : "Request failed.",
    );
  return data as T;
}
export function post<T>(path: string, value: unknown = {}) {
  return api<T>(path, { method: "POST", body: JSON.stringify(value) });
}
