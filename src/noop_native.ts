// Stub module mapped via wrangler.toml [alias] so optional native .node addons
// inside ssh2 (cpu-features / sshcrypto.node) trigger ssh2's built-in try/catch
// fallback to pure JS + workerd node:crypto without requiring a .node loader.
throw new Error("Optional native addon disabled in Cloudflare Workers");
export {};
