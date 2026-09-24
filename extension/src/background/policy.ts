// Safety policy: classifies tool calls by risk and gates sensitive ones
// behind one-click confirmation (allow once / always allow / deny).
// Pure `assess()` is unit-tested; `ConfirmGate` owns the confirm round-trip.
import type { StepEvent } from "../shared/protocol";

export type Risk =
  | { level: "allow" }
  | { level: "confirm"; rule: string; summary: string };

export interface ElementProbe {
  tag: string;
  type?: string;
  role?: string;
  text: string;
  inForm: boolean;
}

const PURCHASE_RE =
  /(checkout|purchase|buy now|place order|pay now|complete order|order now|subscribe)/i;

/** Rules that always require confirmation (per the plan's gate list). */
export function assess(
  name: string,
  args: Record<string, unknown>,
  probe?: ElementProbe | null,
): Risk {
  switch (name) {
    case "evaluate_js":
      return {
        level: "confirm",
        rule: "evaluate_js",
        summary: `Run JavaScript: ${String(args.expression ?? "").slice(0, 140)}`,
      };
    case "download":
      return {
        level: "confirm",
        rule: "download",
        summary: `Download file: ${String(args.url ?? "")}`,
      };
    case "network_mock":
    case "network_rewrite":
      return {
        level: "confirm",
        rule: "network_mock",
        summary: `Modify network traffic (${name})`,
      };
    case "navigate": {
      const url = String(args.url ?? "");
      return PURCHASE_RE.test(url)
        ? {
            level: "confirm",
            rule: "purchase",
            summary: `Navigate to a purchase/checkout page: ${url.slice(0, 120)}`,
          }
        : { level: "allow" };
    }
    case "type": {
      if (probe?.type === "password") {
        return {
          level: "confirm",
          rule: "password",
          summary: `Type into a password field (${probe.tag}#${probe.text.slice(0, 30)})`,
        };
      }
      if (probe?.inForm && args.submit) {
        return {
          level: "confirm",
          rule: "form_submit",
          summary: "Fill and submit a form",
        };
      }
      return { level: "allow" };
    }
    case "click": {
      if (probe && PURCHASE_RE.test(probe.text)) {
        return {
          level: "confirm",
          rule: "purchase",
          summary: `Click a purchase/checkout control: "${probe.text.slice(0, 60)}"`,
        };
      }
      if (probe?.inForm && probe.type === "submit") {
        return {
          level: "confirm",
          rule: "form_submit",
          summary: `Submit a form (click "${probe.text.slice(0, 40) || "submit"}")`,
        };
      }
      return { level: "allow" };
    }
    case "key": {
      const isEnter = String(args.key ?? "").endsWith("Enter");
      if (isEnter && probe?.inForm) {
        return {
          level: "confirm",
          rule: "form_submit",
          summary: "Submit a form (Enter key)",
        };
      }
      return { level: "allow" };
    }
    default:
      return { level: "allow" };
  }
}

export interface GateDeps {
  emit(event: StepEvent): void;
  loadAlways(): Promise<Set<string>>;
  saveAlways(always: Set<string>): Promise<void>;
  timeoutMs?: number;
}

export type GateOutcome = { allow: true } | { allow: false; reason: string };

export class ConfirmGate {
  #pending = new Map<string, (allow: boolean, always: boolean) => void>();
  #always = new Set<string>();

  constructor(private deps: GateDeps) {}

  async ready(): Promise<void> {
    this.#always = await this.deps.loadAlways();
  }

  get alwaysRules(): string[] {
    return [...this.#always];
  }

  async request(risk: Extract<Risk, { level: "confirm" }>): Promise<GateOutcome> {
    if (this.#always.has(risk.rule)) return { allow: true };
    const id = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.deps.emit({ kind: "need_confirm", id, tool: risk.rule, summary: risk.summary });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ allow: false, reason: "confirmation timed out — denied" });
      }, this.deps.timeoutMs ?? 120_000);
      this.#pending.set(id, (allow, always) => {
        clearTimeout(timer);
        if (allow && always) {
          this.#always.add(risk.rule);
          void this.deps.saveAlways(this.#always);
        }
        resolve(
          allow
            ? { allow: true }
            : { allow: false, reason: "cancelled by user (denied)" },
        );
      });
    });
  }

  resolve(id: string, allow: boolean, always: boolean): void {
    const resolver = this.#pending.get(id);
    if (resolver) {
      this.#pending.delete(id);
      resolver(allow, always);
    }
  }
}
