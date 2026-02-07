import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createAutoSocketSelector,
  getDiagnostics,
  getHover,
  getDefinition,
  getReferences,
  getCompletions,
} from "./lib";

const selectSocket = createAutoSocketSelector();

const server = new McpServer({
  name: "nvim-lsp-bridge",
  version: "1.0.0",
});

server.tool(
  "get_diagnostics",
  "Get LSP diagnostics from Neovim, optionally filtered to a specific file",
  { file: z.string().optional().describe("File path to filter diagnostics") },
  async ({ file }) => {
    try {
      const result = await getDiagnostics(selectSocket, file);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: String(err) }], isError: true };
    }
  }
);

const positionSchema = {
  file: z.string().describe("File path"),
  line: z.number().int().describe("Line number (1-based)"),
  col: z.number().int().describe("Column number (1-based)"),
};

server.tool(
  "get_hover",
  "Get hover/type information at a position in a file",
  positionSchema,
  async ({ file, line, col }) => {
    try {
      const result = await getHover(selectSocket, file, line, col);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: String(err) }], isError: true };
    }
  }
);

server.tool(
  "get_definition",
  "Get the definition location of a symbol at a position",
  positionSchema,
  async ({ file, line, col }) => {
    try {
      const result = await getDefinition(selectSocket, file, line, col);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: String(err) }], isError: true };
    }
  }
);

server.tool(
  "get_references",
  "Find all references to a symbol at a position",
  positionSchema,
  async ({ file, line, col }) => {
    try {
      const result = await getReferences(selectSocket, file, line, col);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: String(err) }], isError: true };
    }
  }
);

server.tool(
  "get_completions",
  "Get completion candidates at a position in a file",
  positionSchema,
  async ({ file, line, col }) => {
    try {
      const result = await getCompletions(selectSocket, file, line, col);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: String(err) }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
