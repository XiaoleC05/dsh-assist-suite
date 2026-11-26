/**
 * Host half of the package-root client row (`id: assist-ui`).
 *
 * DSH publishes a package's browser module only from a package-root Loader row
 * (client-modules skips subpath rows), so this empty host plugin exists solely
 * to carry `client.js` — the merged Confluence / pro-prompt / Crisp UI.
 */
export function apply() {}
