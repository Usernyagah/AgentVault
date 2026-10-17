import { handleBackendRequest } from "@/lib/backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleBackendRequest;
export const HEAD = handleBackendRequest;
