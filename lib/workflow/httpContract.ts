export type ResponseValueType = "string" | "number" | "boolean" | "object" | "array" | "non-empty";

export interface ResponseContract {
  fields: Record<string, ResponseValueType>;
}

export function parseStatusSpec(raw: string): { codes: Set<number>; ranges: [number, number][] } {
  const codes = new Set<number>();
  const ranges: [number, number][] = [];
  const parts = raw.split(/[,，\s]+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("成功狀態碼不能是空白");
  for (const part of parts) {
    const range = /^(\d{3})-(\d{3})$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new Error(`狀態碼範圍「${part}」前後顛倒`);
      ranges.push([start, end]);
      continue;
    }
    if (/^\d{3}$/.test(part)) { codes.add(Number(part)); continue; }
    throw new Error(`狀態碼「${part}」格式不正確，請填 200-299 或 200,201`);
  }
  return { codes, ranges };
}

export function statusMatches(status: number, spec: { codes: Set<number>; ranges: [number, number][] }): boolean {
  return spec.codes.has(status) || spec.ranges.some(([start, end]) => status >= start && status <= end);
}

export function parseResponseContract(raw: string): ResponseContract | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("回應欄位合約不是合法 JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("回應欄位合約必須是 JSON 物件");
  const fields: Record<string, ResponseValueType> = {};
  for (const [path, type] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/.test(path) || typeof type !== "string" || !["string", "number", "boolean", "object", "array", "non-empty"].includes(type)) {
      throw new Error(`回應欄位合約「${path}」格式不正確`);
    }
    fields[path] = type as ResponseValueType;
  }
  if (Object.keys(fields).length > 100) throw new Error("回應欄位合約最多 100 個欄位");
  return { fields };
}

function valueAtPath(value: unknown, path: string): { found: boolean; value: unknown } {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || !(key in (current as Record<string, unknown>))) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function matchesType(value: unknown, type: ResponseValueType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "non-empty") return (typeof value === "string" && value.trim().length > 0) || (Array.isArray(value) && value.length > 0) || (Boolean(value) && typeof value === "object" && Object.keys(value as object).length > 0);
  return false;
}

export function validateResponseContract(value: unknown, contract: ResponseContract | null): string[] {
  if (!contract) return [];
  const errors: string[] = [];
  for (const [path, type] of Object.entries(contract.fields)) {
    const found = valueAtPath(value, path);
    if (!found.found) errors.push(`缺少欄位 ${path}`);
    else if (!matchesType(found.value, type)) errors.push(`${path} 應該是 ${type}`);
  }
  return errors;
}
