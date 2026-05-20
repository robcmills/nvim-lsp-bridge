import type { NvimInstance, SocketSelector } from "./lib";
import {
  discoverInstances,
  findInstanceByCwd,
  pingNvim,
  syncBuffer,
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

async function probeStates(instances: NvimInstance[]): Promise<("responsive" | "wedged")[]> {
  return Promise.all(
    instances.map(async (inst) => {
      if (inst.state === "responsive") return "responsive";
      return (await pingNvim(inst.socketPath)) ? "responsive" : "wedged";
    }),
  );
}

function formatInstanceList(
  instances: NvimInstance[],
  states?: ("responsive" | "wedged")[],
): string {
  const cyan = "\x1b[1;36m";
  const gray = "\x1b[38;5;248m";
  const red = "\x1b[31m";
  const reset = "\x1b[0m";

  let output = "";
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]!;
    const wedged = states && states[i] === "wedged";
    const badge = wedged ? ` ${red}[wedged]${reset}` : "";
    output += `  ${cyan}${i + 1}) ${inst.cwd}${reset}${badge}\n     ${gray}${inst.socketPath}${reset}\n`;
  }
  return output;
}

async function confirmResponsive(inst: NvimInstance): Promise<void> {
  if (inst.state === "responsive") return;
  if (await pingNvim(inst.socketPath)) return;
  const pidStr = inst.pid ? ` (PID ${inst.pid})` : "";
  console.error(
    `Matched Neovim at ${inst.cwd}${pidStr} but it is unresponsive — ` +
    "check for a modal prompt (E325 swap-file, hit-enter, etc.).",
  );
  process.exit(1);
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
      await confirmResponsive(instances[0]!);
      return instances[0]!.socketPath;
    }

    // Try to match by current working directory
    const cwdMatch = findInstanceByCwd(instances);
    if (cwdMatch) {
      await confirmResponsive(cwdMatch);
      return cwdMatch.socketPath;
    }

    const states = await probeStates(instances);

    const green = "\x1b[32m";
    const cyan = "\x1b[1;36m";
    const gray = "\x1b[38;5;248m";
    const yellow = "\x1b[33m";
    const magenta = "\x1b[35m";
    const orange = "\x1b[38;5;214m";
    const reset = "\x1b[0m";

    process.stderr.write(`${orange}Multiple Neovim instances found:${reset}\n\n`);
    process.stderr.write(formatInstanceList(instances, states));
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

    const picked = instances[idx]!;
    if (states[idx] === "wedged") {
      const pidStr = picked.pid ? ` (PID ${picked.pid})` : "";
      console.error(
        `Selected Neovim at ${picked.cwd}${pidStr} is unresponsive — ` +
        "check for a modal prompt (E325 swap-file, hit-enter, etc.).",
      );
      process.exit(1);
    }

    return picked.socketPath;
  };
}

async function listInstances(): Promise<void> {
  const instances = await discoverInstances();

  if (instances.length === 0) {
    console.error("No Neovim instances found.");
    process.exit(1);
  }

  const states = await probeStates(instances);

  process.stderr.write(`\nFound ${instances.length} Neovim instance(s):\n\n`);
  process.stderr.write(formatInstanceList(instances, states));
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
      case "sync": {
        const syncFile = args[0];
        if (!syncFile) {
          console.error("Usage: nvim-lsp sync <file>");
          process.exit(1);
        }
        result = await syncBuffer(selectSocket, syncFile);
        break;
      }
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
  sync <file>                     Notify LSP of external file changes
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
