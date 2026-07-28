import type { ParamField, Workflow } from "./types";

export interface InputVariantPlan {
  key: string;
  label: string;
  value: string;
  valueLabel: string;
  params: Record<string, unknown>;
  name: string;
  explanation: string;
}

function optionValue(option: string): { value: string; label: string } {
  const index = option.indexOf("=");
  return index > 0 && index < option.length - 1
    ? { value: option.slice(0, index), label: option.slice(index + 1) }
    : { value: option, label: option };
}

function explicitValues(field: ParamField): { value: string; label: string }[] {
  if (field.type === "boolean") return [{ value: "true", label: "是" }, { value: "false", label: "否" }];
  if (field.type !== "select" || !field.options) return [];
  return field.options.map(optionValue).filter((item, index, all) => item.value.trim() && all.findIndex((other) => other.value === item.value) === index);
}

/**
 * 只從 workflow 已宣告的 select／boolean 選項產生變體。
 * 不替 text/number/file 猜值：那類資料可能有真實業務語意，應由使用者實際輸入或保存成功 run。
 */
export function deriveInputVariantPlans(workflow: Workflow, baseParams: Record<string, unknown>, max = 20): InputVariantPlan[] {
  const plans: InputVariantPlan[] = [];
  for (const field of (workflow.triggerParams ?? []).filter((candidate) => !candidate.derived)) {
    const values = explicitValues(field);
    const current = String(baseParams[field.key] ?? field.default ?? "");
    for (const choice of values) {
      if (choice.value === current) continue;
      const params = { ...baseParams, [field.key]: choice.value };
      plans.push({
        key: field.key,
        label: field.label || field.key,
        value: choice.value,
        valueLabel: choice.label,
        params,
        name: `情境測試：${field.label || field.key}・${choice.label}`,
        explanation: `已把「${field.label || field.key}」改成「${choice.label}」；其他輸入沿用最近一次成功執行。`,
      });
      if (plans.length >= max) return plans;
    }
  }
  return plans;
}

export function findInputVariantPlan(workflow: Workflow, baseParams: Record<string, unknown>, key: string, value: string): InputVariantPlan | null {
  return deriveInputVariantPlans(workflow, baseParams, 100).find((plan) => plan.key === key && plan.value === value) ?? null;
}
