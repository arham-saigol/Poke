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
      const nextRunAt = automation.nextRunAt
        ?? computeNextCronOccurrence(
          automation.schedule.value,
          automation.schedule.timezone,
          automation.lastRunAt ? new Date(automation.lastRunAt) : now
        )?.toISOString();
      return nextRunAt ? Date.parse(nextRunAt) <= now.getTime() : false;
    }

    return false;
  });
}

export async function runAutomation(automation: Automation): Promise<{ status: "completed" | "failed"; output: string }> {
  appendLog("info", "automation.run.start", { name: automation.name, action: automation.action.type });
  if (automation.action.type === "prompt") {
    try {
      const runtime = await loadAgentRuntime();
      const result = await runtime.parentTools.ask_poke({
        task: automation.action.prompt,
        reasoning: automation.action.reasoning ?? "low"
      });
      appendLog("info", "automation.run.completed", { name: automation.name, status: "completed" });
      return { status: "completed", output: String(result.output ?? "") };
    } catch (error) {
      appendLog("error", "automation.run.completed", {
        name: automation.name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        status: "failed",
        output: error instanceof Error ? error.message : String(error)
      };
    }
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

type CronField = {
  values: Set<number>;
};

function computeNextCronOccurrence(expression: string, timeZone: string, reference: Date): Date | null {
  const [minute, hour, dayOfMonth, month, dayOfWeek, extra] = expression.trim().split(/\s+/);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek || extra) {
    throw new Error(`Unsupported cron expression: ${expression}`);
  }
  const fields = {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek, 0, 6, true)
  };
  const cursor = new Date(reference);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    const parts = zonedDateParts(cursor, timeZone);
    if (
      fields.minute.values.has(parts.minute)
      && fields.hour.values.has(parts.hour)
      && fields.dayOfMonth.values.has(parts.dayOfMonth)
      && fields.month.values.has(parts.month)
      && fields.dayOfWeek.values.has(parts.dayOfWeek)
    ) {
      return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function parseCronField(field: string, min: number, max: number, mapSunday = false): CronField {
  const values = new Set<number>();
  for (const segment of field.split(",")) {
    const [base, stepPart] = segment.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step: ${segment}`);
    }
    const [rangeStart, rangeEnd] = parseCronRange(base, min, max, mapSunday);
    for (let value = rangeStart; value <= rangeEnd; value += step) {
      values.add(mapCronValue(value, mapSunday));
    }
  }
  return { values };
}

function parseCronRange(field: string, min: number, max: number, mapSunday: boolean): [number, number] {
  if (field === "*") {
    return [min, max];
  }
  if (field.includes("-")) {
    const [startText, endText] = field.split("-", 2);
    const start = parseCronValue(startText, min, max, mapSunday);
    const end = parseCronValue(endText, min, max, mapSunday);
    if (start > end) {
      throw new Error(`Invalid cron range: ${field}`);
    }
    return [start, end];
  }
  const value = parseCronValue(field, min, max, mapSunday);
  return [value, value];
}

function parseCronValue(value: string, min: number, max: number, mapSunday: boolean): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid cron value: ${value}`);
  }
  const normalized = mapCronValue(parsed, mapSunday);
  if (normalized < min || normalized > max) {
    throw new Error(`Cron value out of range: ${value}`);
  }
  return normalized;
}

function mapCronValue(value: number, mapSunday: boolean): number {
  if (mapSunday && value === 7) {
    return 0;
  }
  return value;
}

function zonedDateParts(date: Date, timeZone: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    dayOfMonth: Number(values.day),
    month: Number(values.month),
    dayOfWeek: weekdayMap[values.weekday ?? "Sun"] ?? 0
  };
}

async function loadAgentRuntime(): Promise<{
  parentTools: {
    ask_poke: (input: { task: string; reasoning: "low" | "medium" | "high" }) => Promise<{ output: string }>;
  };
}> {
  let lastError: unknown;
  for (const candidate of [
    new URL("../../agent-runtime/src/index.ts", import.meta.url),
    new URL("../../agent-runtime/generated-dist/index.js", import.meta.url)
  ]) {
    try {
      return await import(candidate.href) as {
        parentTools: {
          ask_poke: (input: { task: string; reasoning: "low" | "medium" | "high" }) => Promise<{ output: string }>;
        };
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to load agent runtime.");
}
