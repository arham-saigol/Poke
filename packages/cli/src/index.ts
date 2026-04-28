#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { runMemoryCleanup } from "@poke/memory";
import { seedBundledSkills } from "@poke/skills";
import {
  appendLog,
  audit,
  bootstrapPokeHome,
  createBackup,
  getPokePaths,
  listBackups,
  migrateDatabase,
  readConfig,
  restoreBackup,
  writeConfig
} from "@poke/storage";

const program = new Command();

program.name("poke").description("Poke personal agent daemon CLI").version("0.1.0");

program
  .command("setup")
  .description("Run the setup wizard")
  .option("--home <path>", "Poke home directory")
  .option("--non-interactive", "Create local defaults without prompts")
  .action((options: { home?: string; nonInteractive?: boolean }) => {
    const paths = bootstrapPokeHome({ home: options.home });
    seedBundledSkills(paths);
    try {
      migrateDatabase(paths);
    } catch (error) {
      appendLog("warn", "storage.sqlite_unavailable", { error: String(error) });
      console.log("SQLite native bindings are not available yet. Run `pnpm approve-builds` and allow better-sqlite3, then reinstall.");
    }
    const config = readConfig(paths);
    console.log(`Poke home: ${paths.home}`);
    console.log("Created config, storage directories, memory index, bundled skills, default automation, secrets, and database.");

    const cloudflared = commandExists("cloudflared");
    if (!cloudflared) {
      console.log("cloudflared was not found. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    } else {
      console.log("cloudflared found.");
      console.log("To authenticate on a headless VPS, run: cloudflared tunnel login");
      console.log("Open the printed browser URL on your own machine and complete Cloudflare login.");
    }

    if (!options.nonInteractive) {
      console.log("Interactive tunnel and Cloudflare Access setup will be expanded in the web/setup UI.");
      console.log("For now, edit config.json publicBaseUrl after creating your tunnel.");
    }

    writeConfig(config, paths);
  });

program
  .command("start")
  .description("Start the daemon")
  .option("--foreground", "Run in the current process")
  .action((options: { foreground?: boolean }) => {
    const paths = bootstrapPokeHome();
    if (isDaemonRunning(paths.pid)) {
      console.log(`Poke daemon is already running with pid ${fs.readFileSync(paths.pid, "utf8").trim()}.`);
      return;
    }

    const gateway = resolveGatewayCommand();
    if (options.foreground) {
      const child = spawn(gateway.command, gateway.args, {
        stdio: "inherit",
        env: { ...process.env, POKE_HOME: paths.home }
      });
      child.on("exit", (code) => {
        process.exitCode = code ?? 0;
      });
      return;
    }

    const out = fs.openSync(path.join(paths.logs, "gateway.stdout.log"), "a");
    const err = fs.openSync(path.join(paths.logs, "gateway.stderr.log"), "a");
    const child = spawn(gateway.command, gateway.args, {
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, POKE_HOME: paths.home }
    });
    child.unref();
    
    try {
      fs.writeFileSync(paths.pid, String(child.pid), "utf8");
    } catch (error) {
      console.error(`Failed to write PID file: ${String(error)}`);
      throw error;
    }
    
    console.log(`Started Poke daemon with pid ${child.pid}.`);
  });

program
  .command("stop")
  .description("Stop the daemon")
  .action(() => {
    const paths = getPokePaths();
    const pid = readPid(paths.pid);
    if (!pid) {
      console.log("Poke daemon is not running.");
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
      fs.rmSync(paths.pid, { force: true });
      console.log(`Sent SIGTERM to Poke daemon pid ${pid}.`);
    } catch (error) {
      console.error(`Failed to stop pid ${pid}: ${String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("restart")
  .description("Restart the daemon")
  .action(() => {
    const paths = bootstrapPokeHome();
    const pid = readPid(paths.pid);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        fs.rmSync(paths.pid, { force: true });
      }
    }
    const result = spawnSync(process.execPath, [process.argv[1]!, "start"], { stdio: "inherit" });
    process.exitCode = result.status ?? 0;
  });

program
  .command("status")
  .description("Show daemon status")
  .action(() => {
    const paths = bootstrapPokeHome();
    const config = readConfig(paths);
    const pid = readPid(paths.pid);
    const running = pid ? processExists(pid) : false;
    console.log(JSON.stringify(
      {
        running,
        pid: running ? pid : null,
        home: paths.home,
        publicBaseUrl: config.publicBaseUrl,
        logFile: path.join(paths.logs, "gateway.log")
      },
      null,
      2
    ));
  });

program
  .command("logs")
  .description("Output daemon logs")
  .option("-f, --follow", "Follow log output")
  .action((options: { follow?: boolean }) => {
    const logFile = path.join(getPokePaths().logs, "gateway.log");
    if (!fs.existsSync(logFile)) {
      console.log("No gateway log file exists yet.");
      return;
    }
    if (!options.follow) {
      process.stdout.write(fs.readFileSync(logFile, "utf8"));
      return;
    }
    const child = spawn(process.platform === "win32" ? "powershell" : "tail", process.platform === "win32" ? ["-NoProfile", "-Command", `Get-Content -Wait -Path '${logFile.replaceAll("'", "''")}'`] : ["-f", logFile], {
      stdio: "inherit"
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
    });
  });

const memory = program.command("memory").description("Memory operations");
memory
  .command("cleanup")
  .description("Run the memory cleanup pipeline")
  .action(() => {
    const paths = bootstrapPokeHome();
    const report = runMemoryCleanup(paths);
    console.log(`Memory cleanup completed. Backup: ${report.backupPath}`);
    console.log(`Report: ${report.reportPath}`);
    console.log(`Mutations applied: ${report.mutationsApplied}`);
  });

const backup = program.command("backup").description("Backup and restore user state");
backup
  .command("create")
  .description("Create a backup of Poke user state")
  .argument("[label]", "Backup label", "manual")
  .action((label: string) => {
    const paths = bootstrapPokeHome();
    console.log(createBackup(label, paths));
  });

backup
  .command("list")
  .description("List backups")
  .action(() => {
    bootstrapPokeHome();
    console.log(JSON.stringify(listBackups(), null, 2));
  });

backup
  .command("restore")
  .description("Restore a backup after first creating a safety backup")
  .argument("<path>", "Backup directory path")
  .action((backupPath: string) => {
    const paths = bootstrapPokeHome();
    const result = restoreBackup(backupPath, paths);
    console.log(`Restored from ${result.restoredFrom}`);
    console.log(`Safety backup created at ${result.safetyBackup}`);
  });

program
  .command("update")
  .description("Update Poke without resetting user state")
  .action(() => {
    bootstrapPokeHome();
    const backup = createBackup("pre-update");
    console.log(`Created pre-update backup at ${backup}`);
    const git = spawnSync("git", ["pull", "--ff-only"], { stdio: "inherit" });
    if (git.status !== 0) {
      console.error("git pull failed; user state backup was preserved.");
      process.exitCode = git.status ?? 1;
      return;
    }
    const install = spawnSync("pnpm", ["install"], { stdio: "inherit" });
    if (install.status !== 0) {
      process.exitCode = install.status ?? 1;
      return;
    }
    migrateDatabase();
    const restart = spawnSync(process.execPath, [process.argv[1]!, "restart"], { stdio: "inherit" });
    process.exitCode = restart.status ?? 0;
  });

program
  .command("help-all")
  .description("List all available commands")
  .action(() => program.help());

program.parse();

function resolveGatewayCommand(): { command: string; args: string[] } {
  const root = findWorkspaceRoot();
  const source = path.resolve(root, "apps/gateway/src/index.ts");
  const built = path.resolve(root, "apps/gateway/dist/index.js");
  if (fs.existsSync(built)) return { command: process.execPath, args: [built] };
  if (fs.existsSync(source)) {
    const tsxBin = path.resolve(root, "node_modules/tsx/dist/cli.mjs");
    if (fs.existsSync(tsxBin)) return { command: process.execPath, args: [tsxBin, source] };
  }
  throw new Error("Gateway entrypoint not found. Run pnpm install and pnpm build first.");
}

function findWorkspaceRoot(): string {
  let current = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function readPid(pidFile: string): number | null {
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isDaemonRunning(pidFile: string): boolean {
  const pid = readPid(pidFile);
  return pid ? processExists(pid) : false;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command: string): boolean {
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(checker, args, { stdio: "ignore", shell: process.platform !== "win32" });
  return result.status === 0;
}
