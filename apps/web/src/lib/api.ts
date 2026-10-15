import type { ApiResponse } from "@agentvault/shared";

export type ApplicationMode = "demo" | "live";

export interface ApiResult<T> {
  data: T;
  mode: ApplicationMode;
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<ApiResult<T>> {
  const response = await fetch(path, {
    ...options,
    cache: options?.cache ?? "no-store",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as ApiResponse<T> | null;

  if (!response.ok || !body?.success) {
    throw new Error(body?.error || `API request failed (${response.status}).`);
  }

  const mode = response.headers.get("X-AgentVault-Mode");
  if (mode !== "demo" && mode !== "live") {
    throw new Error("The API did not provide a verifiable Demo/Live mode.");
  }
  return { data: body.data as T, mode };
}
