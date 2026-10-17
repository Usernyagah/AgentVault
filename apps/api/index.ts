// Vercel serverless function entry point for Hono
import app from "./dist/index.js";
import { handle } from "@hono/vercel";

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const PATCH = handle(app);
