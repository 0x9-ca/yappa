// Files under src/client are imported as text or binary (see "rules" in wrangler.jsonc).
declare module "*/client/app.js" {
  const source: string;
  export default source;
}
declare module "*/client/tools.js" {
  const source: string;
  export default source;
}
declare module "*/client/theme.js" {
  const source: string;
  export default source;
}
declare module "hls.js/dist/hls.light.min.js" {
  const source: string;
  export default source;
}
declare module "*/client/sw.js" {
  const source: string;
  export default source;
}
declare module "*/client/app.css" {
  const source: string;
  export default source;
}
declare module "*.png" {
  const data: ArrayBuffer;
  export default data;
}
