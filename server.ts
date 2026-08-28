/**
 * Static file server for the Inhaler Result Analyzer.
 * Serves /public as the web root and /models for ONNX/TXT model assets.
 * Pure Deno runtime, no Node.js dependency.
 */

const PORT = Number(Deno.env.get("PORT") || 4200);
const CWD = Deno.cwd();
const PUBLIC_ROOT = `${CWD}\\public`;
const MODELS_ROOT = `${CWD}\\models`;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function contentType(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = filePath.slice(dot).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

function resolvePath(urlPath: string): { path: string; root: string } | null {
  // Reject attempts to escape the project folder.
  if (urlPath.includes("..")) return null;

  if (urlPath.startsWith("/models")) {
    const rel = urlPath.slice("/models".length).replace(/\/+/g, "\\");
    return { path: `${MODELS_ROOT}${rel}`, root: MODELS_ROOT };
  }

  const rel = urlPath.replace(/\/+/g, "\\");
  return { path: `${PUBLIC_ROOT}${rel}`, root: PUBLIC_ROOT };
}

async function handler(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(req.url);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || pathname === "") pathname = "/index.html";

  const resolved = resolvePath(pathname);
  if (!resolved) {
    return new Response("Forbidden", { status: 403 });
  }

  // Make sure a .html request that points to a directory-like path works.
  if (pathname.endsWith("/")) pathname += "index.html";

  try {
    const stat = await Deno.stat(resolved.path);
    if (stat.isFile) {
      const file = await Deno.open(resolved.path, { read: true });
      const body = req.method === "HEAD" ? null : file.readable;
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": contentType(resolved.path),
          "content-length": String(stat.size),
          "cache-control": "no-cache",
        },
      });
    }
    return new Response("Not Found", { status: 404 });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

Deno.serve({ port: PORT }, handler);