/**
 * Public surface of @mdlineage/mcp-server.
 *
 * The implementation lives in `server-impl.ts`; this barrel keeps the package's
 * import path (`@mdlineage/mcp-server`) stable while the modules behind it are
 * free to move, the way the validator's own index does.
 */

export {
  ProposalQueue,
  buildProposals,
  applyProposalToContent,
  diffOf,
  resetProposalIds,
  createContext,
  createMdlineageMcpServer,
  connectToTransport,
  startStdio,
  TOOL_NAMES,
} from './server-impl.js';
export type {
  MetadataProposal,
  MetadataOperation,
  FrontMatterTextEdit,
  AppliedPatch,
} from './proposals.js';
export type { McpServerContext, McpServerOptions, ConfigDiagnosticReport, ToolDiagnostic } from './server-impl.js';
