// Bun loads `*.sql` imports tagged `with { type: "text" }` as their file contents,
// and `bun build --compile` embeds them in the standalone binary. This declares the
// default export as a string so the compiler agrees.
declare module "*.sql" {
  const content: string;
  export default content;
}
