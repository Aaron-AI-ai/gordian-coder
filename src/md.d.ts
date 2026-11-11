// Allow importing .md files as text (Bun bundles the content inline at build).
declare module "*.md" {
  const content: string;
  export default content;
}
