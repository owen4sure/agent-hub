export interface ComponentHealth {
  ok: boolean;
  message: string;
  checkedAt: string;
}

declare global {
  var __agentHubComponentHealth: Record<string, ComponentHealth> | undefined;
}

function store() {
  global.__agentHubComponentHealth ??= {};
  return global.__agentHubComponentHealth;
}

export function markComponentHealth(name: string, ok: boolean, message: string) {
  store()[name] = { ok, message, checkedAt: new Date().toISOString() };
}

export function getComponentHealth(): Record<string, ComponentHealth> {
  return { ...store() };
}
