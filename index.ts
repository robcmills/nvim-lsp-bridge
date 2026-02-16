import type { NvimInstance, SocketSelector } from "./lib";
import {
  findAllNeovimSockets,
  getNvimInfo,
  getDiagnostics,
  getHover,
  getDefinition,
  getReferences,
  getCompletions,
} from "./lib";

function promptChoice(question: string): Promise<string> {
  process.stderr.write(question);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString().trim());
    });
  });
}

async function discoverInstances(): Promise<NvimInstance[]> {
  const sockets = findAllNeovimSockets();

  if (sockets.length === 0) {
    return [];
  }

  return (await Promise.all(sockets.map(getNvimInfo))).filter(
    (i): i is NvimInstance => i !== null
  );
}

function formatInstanceList(instances: NvimInstance[]): string {
  const cyan = "\x1b[1;36m";
  const gray = "\x1b[38;5;248m";
  const reset = "\x1b[0m";

  let output = "";
  for (let i = 0; i < instances.length; i++) {
    output += `  ${cyan}${i + 1}) ${instances[i]!.cwd}${reset}\n     ${gray}${instances[i]!.socketPath}${reset}\n`;
  }
  return output;
}

function createInteractiveSocketSelector(): SocketSelector {
  return async () => {
    if (process.env.NVIM_LISTEN_ADDRESS) {
      return process.env.NVIM_LISTEN_ADDRESS;
    }

    const instances = await discoverInstances();

    if (instances.length === 0) {
      console.error(
        "No Neovim instances found.\n\n" +
        "Start Neovim or set NVIM_LISTEN_ADDRESS to a socket path.\n" +
        "Example: export NVIM_LISTEN_ADDRESS=/tmp/nvim.sock"
      );
      process.exit(1);
    }

    if (instances.length === 1) {
      return instances[0]!.socketPath;
    }

    const green = "\x1b[32m";
    const cyan = "\x1b[1;36m";
    const gray = "\x1b[38;5;248m";
    const yellow = "\x1b[33m";
    const magenta = "\x1b[35m";
    const orange = "\x1b[38;5;214m";
    const reset = "\x1b[0m";

    process.stderr.write(`${orange}Multiple Neovim instances found:${reset}\n\n`);
    process.stderr.write(formatInstanceList(instances));
    process.stderr.write(
      `\n${gray}Tip: Set ${cyan}NVIM_LISTEN_ADDRESS${gray} to skip this prompt.${reset}\n` +
      `${gray}Example:${reset} ${green}export${reset} ${cyan}NVIM_LISTEN_ADDRESS${reset}${yellow}=${reset}${magenta}/path/to/nvim/socket${reset}\n\n`
    );

    const answer = await promptChoice(`Select instance (1-${instances.length}): `);
    const idx = parseInt(answer) - 1;

    if (isNaN(idx) || idx < 0 || idx >= instances.length) {
      console.error("Invalid selection.");
      process.exit(1);
    }

    return instances[idx]!.socketPath;
  };
}

async function listInstances(): Promise<void> {
  const instances = await discoverInstances();

  if (instances.length === 0) {
    console.error("No Neovim instances found.");
    process.exit(1);
  }

  process.stderr.write(`\nFound ${instances.length} Neovim instance(s):\n\n`);
  process.stderr.write(formatInstanceList(instances));
}

const selectSocket = createInteractiveSocketSelector();
const command = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  try {
    let result: unknown;

    switch (command) {
      case "list":
        await listInstances();
        process.exit(0);
        break;
      case "diagnostics":
        result = await getDiagnostics(selectSocket, args[0]);
        break;
      case "hover":
      case "definition":
      case "references":
      case "completions": {
        const file = args[0];
        const line = args[1];
        const col = args[2];
        if (!file || !line || !col) {
          console.error(`Usage: nvim-lsp ${command} <file> <line> <col>`);
          process.exit(1);
        }
        const fns = { hover: getHover, definition: getDefinition, references: getReferences, completions: getCompletions };
        result = await fns[command](selectSocket, file, parseInt(line), parseInt(col));
        break;
      }
      default:
        console.error(`Usage: nvim-lsp <command> [args...]

Commands:
  list                            List Neovim instances and sockets
  diagnostics [file]              Get LSP diagnostics
  hover <file> <line> <col>       Get hover/type info
  definition <file> <line> <col>  Go to definition
  references <file> <line> <col>  Find references
  completions <file> <line> <col> Get completions`);
        process.exit(1);
    }

    const output = JSON.stringify(result, null, 2);
    await new Promise<void>((resolve) => {
      process.stdout.write(output + "\n", () => resolve());
    });
    process.exit(0);
  } catch (err) {
    const { writeFileSync } = await import("fs");
    writeFileSync("/tmp/nvim-bridge-error.log", String(err) + "\n" + (err instanceof Error ? err.stack : ""));
    await new Promise<void>((resolve) => {
      process.stderr.write("Error: " + String(err) + "\n", () => resolve());
    });
    process.exit(1);
  }
}

main();
