// Allow importing .md files as text (Bun bundles the content inline at build).
declare module "*.md" {
  const content: string;
  export default content;
}

// Code-generation templates bundled as text (see core/pb-online).
declare module "*.java" {
  const content: string;
  export default content;
}
