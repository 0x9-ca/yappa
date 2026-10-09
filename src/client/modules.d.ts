// Files under src/client are imported as text (see "rules" in wrangler.jsonc).
declare module "*/client/app.js" {
  const source: string;
  export default source;
}
declare module "*/client/app.css" {
  const source: string;
  export default source;
}
