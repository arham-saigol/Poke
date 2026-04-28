import { spawn } from "node:child_process";
import { automationsFileSchema, type Automation } from "@poke/shared";
import { appendLog, readAutomations } from "@poke/storage";

export function validateAutomations(value: unknown): Automation[] {
  return automationsFileSchema.parse(value);
}

export function loadAutomations(): Automation[] {
  return readAutomations();
}

export function dueAutomations(now = new Date(), automations = loadAutomations()): Automation[] {
  return automations.filter((automation) => {
    if (!automation.enabled) return false;
    
    if (automation.schedule.type === "at") {
      return Date.parse(automation.schedule.value) <= now.getTime() && !automation.lastRunAt;
    }
    
    if (automation.schedule.type === "cron") {
      // For cron schedules, check if we've passed the nextRunAt time
      // If nextRunAt is not set or we're past it, the automation is due
      if (!automation.nextRunAt) return true;
      return Date.parse(automation.nextRunAt) <= now.getTime();
    }
    
    return false;
  });
}

export async function runAutomation(automation: Automation): Promise<{ status: "completed" | "failed"; output: string }> {
  appendLog("info", "automation.run.start", { name: automation.name, action: automation.action.type });
  if (automation.action.type === "prompt") {
    const output = `Prompt automation queued for agent runtime: ${automation.action.prompt}`;
    appendLog("info", "automation.run.completed", { name: automation.name, status: "completed" });
    return { status: "completed", output };
  }
  return runCommand(automation);
}

function runCommand(automation: Automation): Promise<{ status: "completed" | "failed"; output: string }> {
  if (automation.action.type !== "command") throw new Error("Expected command automation.");
  const action = automation.action;
  return new Promise((resolve) => {
    let settled = false;
    
    const child = spawn(action.command, {
      cwd: action.cwd,
      shell: true,
      timeout: (action.timeoutSeconds ?? 300) * 1000
    });
    
    let output = "";
    
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      
      const errorMessage = `Process error: ${error.message}`;
      appendLog("error", "automation.run.error", {
        name: automation.name,
        status: "failed",
        error: error.message
      });
      
      resolve({ 
        status: "failed", 
        output: output + "\n" + errorMessage
      });
    });
    
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      
      const status = code === 0 ? "completed" : "failed";
      appendLog(status === "completed" ? "info" : "error", "automation.run.finished", {
        name: automation.name,
        status,
        code
      });
      resolve({ status, output });
    });
  });
}
