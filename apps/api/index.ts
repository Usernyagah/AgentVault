// Vercel serverless function entry point for Hono
import app from "./dist/index.js";
import { handle } from "@hono/vercel";

export default handle(app);
