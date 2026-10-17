function isVercelDeployment(): boolean {
  return process.env.VERCEL === "1" || process.env.VERCEL === "true";
}

function apiBaseUrl(): string {
  return (
    process.env.AGENTVAULT_API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:4000"
  ).replace(/\/+$/, "");
}

export async function handleBackendRequest(request: Request): Promise<Response> {
  if (isVercelDeployment()) {
    const { default: app } = await import("@agentvault/api");
    return app.fetch(request);
  }

  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");

  return fetch(`${apiBaseUrl()}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
    cache: "no-store",
  });
}
