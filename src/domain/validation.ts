import {
  MINIMUM_PALLET_GAP_MM,
  type ContainerType,
  type PalletType,
  type PlanInput,
  type ProductType,
} from "./model.js";
import { generateOrientations } from "./orientations.js";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  path: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const error = (code: string, path: string, message: string): ValidationIssue => ({
  severity: "error",
  code,
  path,
  message,
});

const warning = (code: string, path: string, message: string): ValidationIssue => ({
  severity: "warning",
  code,
  path,
  message,
});

function requirePositiveInteger(
  value: number,
  path: string,
  label: string,
  issues: ValidationIssue[],
): void {
  if (!Number.isInteger(value) || value <= 0) {
    issues.push(error("POSITIVE_INTEGER_REQUIRED", path, `${label}必须是正整数。`));
  }
}

function requireNonEmpty(value: string, path: string, label: string, issues: ValidationIssue[]): void {
  if (value.trim().length === 0) {
    issues.push(error("VALUE_REQUIRED", path, `${label}不能为空。`));
  }
}

function productFitsPallet(product: ProductType, pallet: PalletType): boolean {
  if (product.weightG > pallet.maxLoadG) return false;
  return generateOrientations(product).some((orientation) =>
    orientation.lengthMm <= pallet.lengthMm
    && orientation.widthMm <= pallet.widthMm
    && orientation.heightMm + pallet.heightMm <= pallet.maxLoadedHeightMm
  );
}

function validateProduct(product: ProductType, index: number, pallets: Map<string, PalletType>): ValidationIssue[] {
  const path = `products[${index}]`;
  const issues: ValidationIssue[] = [];
  requireNonEmpty(product.id, `${path}.id`, "产品 ID", issues);
  requireNonEmpty(product.sku, `${path}.sku`, "SKU", issues);
  requireNonEmpty(product.name, `${path}.name`, "产品名称", issues);
  requirePositiveInteger(product.lengthMm, `${path}.lengthMm`, "产品长度", issues);
  requirePositiveInteger(product.widthMm, `${path}.widthMm`, "产品宽度", issues);
  requirePositiveInteger(product.heightMm, `${path}.heightMm`, "产品高度", issues);
  requirePositiveInteger(product.weightG, `${path}.weightG`, "产品毛重", issues);
  requirePositiveInteger(product.quantity, `${path}.quantity`, "产品数量", issues);
  requirePositiveInteger(product.priority, `${path}.priority`, "产品优先级", issues);

  if (product.maxTopLoadG !== undefined && (!Number.isInteger(product.maxTopLoadG) || product.maxTopLoadG < 0)) {
    issues.push(error("INVALID_TOP_LOAD", `${path}.maxTopLoadG`, "顶部承重必须是大于等于零的整数克数。"));
  }
  if (product.maxStackLayers !== undefined) {
    requirePositiveInteger(product.maxStackLayers, `${path}.maxStackLayers`, "最大堆叠层数", issues);
  }
  if (!product.stackable && product.maxStackLayers !== undefined && product.maxStackLayers > 1) {
    issues.push(error("STACK_RULE_CONFLICT", `${path}.maxStackLayers`, "不可叠放产品的最大堆叠层数不能大于 1。"));
  }
  if (product.mustStayUpright && (product.allowSideLoading || product.allowUpsideDown)) {
    issues.push(error("UPRIGHT_RULE_CONFLICT", path, "必须正放的产品不能同时允许侧装或倒置。"));
  }

  const eligibleIds = product.eligiblePalletTypeIds ?? [...pallets.keys()];
  const unknownPalletIds = eligibleIds.filter((id) => !pallets.has(id));
  if (unknownPalletIds.length > 0) {
    issues.push(error("UNKNOWN_PALLET_TYPE", `${path}.eligiblePalletTypeIds`, `引用了不存在的托盘：${unknownPalletIds.join("、")}。`));
  }
  if (product.palletPolicy === "required") {
    const eligiblePallets = eligibleIds.flatMap((id) => {
      const pallet = pallets.get(id);
      return pallet === undefined ? [] : [pallet];
    });
    if (eligiblePallets.length === 0) {
      issues.push(error("PALLET_REQUIRED", `${path}.palletPolicy`, "产品必须打托，但方案中没有可用托盘。"));
    } else if (eligiblePallets.every((pallet) => !productFitsPallet(product, pallet))) {
      issues.push(error("NO_FITTING_PALLET", `${path}.eligiblePalletTypeIds`, "产品必须打托，但没有尺寸、载重和含托高度均可行的托盘。"));
    }
  }

  if (issues.every((issue) => !issue.path.startsWith(`${path}.lengthMm`) && !issue.path.startsWith(`${path}.widthMm`) && !issue.path.startsWith(`${path}.heightMm`))) {
    if (generateOrientations(product).length === 0) {
      issues.push(error("NO_ALLOWED_ORIENTATION", path, "产品不存在任何允许朝向。"));
    }
  }
  if (product.maxTopLoadG === undefined && product.stackable) {
    issues.push(warning("TOP_LOAD_UNKNOWN", `${path}.maxTopLoadG`, "可叠放产品未填写顶部承重。"));
  }
  return issues;
}

function validatePallet(pallet: PalletType, index: number): ValidationIssue[] {
  const path = `palletTypes[${index}]`;
  const issues: ValidationIssue[] = [];
  requireNonEmpty(pallet.id, `${path}.id`, "托盘 ID", issues);
  requireNonEmpty(pallet.code, `${path}.code`, "托盘编号", issues);
  requireNonEmpty(pallet.name, `${path}.name`, "托盘名称", issues);
  requirePositiveInteger(pallet.lengthMm, `${path}.lengthMm`, "托盘长度", issues);
  requirePositiveInteger(pallet.widthMm, `${path}.widthMm`, "托盘宽度", issues);
  requirePositiveInteger(pallet.heightMm, `${path}.heightMm`, "托盘高度", issues);
  requirePositiveInteger(pallet.maxLoadG, `${path}.maxLoadG`, "托盘最大载重", issues);
  requirePositiveInteger(pallet.maxLoadedHeightMm, `${path}.maxLoadedHeightMm`, "托盘最大含托高度", issues);
  if (pallet.maxLoadedHeightMm < pallet.heightMm) {
    issues.push(error("PALLET_HEIGHT_CONFLICT", `${path}.maxLoadedHeightMm`, "最大含托高度不能小于托盘自身高度。"));
  }
  if (pallet.minimumGapMm < MINIMUM_PALLET_GAP_MM) {
    issues.push(error("PALLET_GAP_TOO_SMALL", `${path}.minimumGapMm`, `托盘最小净间距不能小于 ${MINIMUM_PALLET_GAP_MM} mm。`));
  }
  if (pallet.overhangMm !== 0) {
    issues.push(error("PALLET_OVERHANG_FORBIDDEN", `${path}.overhangMm`, "产品不允许超出托盘边缘，外伸量必须为 0。"));
  }
  if (pallet.supplyMode !== "unlimited") {
    issues.push(error("PALLET_SUPPLY_MODE", `${path}.supplyMode`, "当前项目只支持无限供应托盘。"));
  }
  if (pallet.allowDoubleStack) {
    issues.push(error("PALLET_DOUBLE_STACK_FORBIDDEN", `${path}.allowDoubleStack`, "完整托盘禁止上下叠放。"));
  }
  if (pallet.unitCost !== undefined && (!Number.isFinite(pallet.unitCost) || pallet.unitCost < 0)) {
    issues.push(error("INVALID_UNIT_COST", `${path}.unitCost`, "托盘采购单价不能为负数。"));
  }
  return issues;
}

function validateContainer(container: ContainerType, index: number): ValidationIssue[] {
  const path = `containerTypes[${index}]`;
  const issues: ValidationIssue[] = [];
  requireNonEmpty(container.id, `${path}.id`, "柜型 ID", issues);
  requireNonEmpty(container.code, `${path}.code`, "柜型编号", issues);
  requireNonEmpty(container.name, `${path}.name`, "柜型名称", issues);
  requirePositiveInteger(container.innerLengthMm, `${path}.innerLengthMm`, "柜内长度", issues);
  requirePositiveInteger(container.innerWidthMm, `${path}.innerWidthMm`, "柜内宽度", issues);
  requirePositiveInteger(container.innerHeightMm, `${path}.innerHeightMm`, "柜内高度", issues);
  requirePositiveInteger(container.doorWidthMm, `${path}.doorWidthMm`, "柜门宽度", issues);
  requirePositiveInteger(container.doorHeightMm, `${path}.doorHeightMm`, "柜门高度", issues);
  requirePositiveInteger(container.maxPayloadG, `${path}.maxPayloadG`, "柜体最大有效载荷", issues);
  requirePositiveInteger(container.quantity, `${path}.quantity`, "柜体数量", issues);
  if (container.doorWidthMm > container.innerWidthMm || container.doorHeightMm > container.innerHeightMm) {
    issues.push(warning("DOOR_DIMENSION_SUSPICIOUS", path, "柜门尺寸大于对应内部尺寸，请确认数据。"));
  }
  return issues;
}

function duplicateIssues(values: string[], path: string, label: string): ValidationIssue[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values.map((item) => item.trim().toUpperCase()).filter(Boolean)) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].map((value) => error("DUPLICATE_VALUE", path, `${label}不能重复：${value}。`));
}

export function validatePlanInput(input: PlanInput): ValidationReport {
  const issues: ValidationIssue[] = [];
  requireNonEmpty(input.id, "id", "方案 ID", issues);
  if (input.products.length === 0) issues.push(error("PRODUCT_REQUIRED", "products", "至少需要一个产品。"));
  if (input.containerTypes.length === 0) issues.push(error("CONTAINER_REQUIRED", "containerTypes", "至少需要一种柜型。"));
  if (input.mode !== "loose" && input.palletTypes.length === 0) {
    issues.push(error("PALLET_REQUIRED_BY_MODE", "palletTypes", "托盘或混装模式至少需要一种托盘。"));
  }
  if (!(input.minimumSupportRatio > 0 && input.minimumSupportRatio <= 1)) {
    issues.push(error("INVALID_SUPPORT_RATIO", "minimumSupportRatio", "最低支撑率必须大于 0 且不大于 1。"));
  } else if (input.minimumSupportRatio < 1) {
    issues.push(warning("PARTIAL_SUPPORT_ENABLED", "minimumSupportRatio", "当前最低支撑率低于默认的 100%。"));
  }

  const pallets = new Map(input.palletTypes.map((pallet) => [pallet.id, pallet]));
  input.products.forEach((product, index) => issues.push(...validateProduct(product, index, pallets)));
  input.palletTypes.forEach((pallet, index) => issues.push(...validatePallet(pallet, index)));
  input.containerTypes.forEach((container, index) => issues.push(...validateContainer(container, index)));
  issues.push(...duplicateIssues(input.products.map((product) => product.sku), "products", "SKU"));
  issues.push(...duplicateIssues(input.products.map((product) => product.id), "products", "产品 ID"));
  issues.push(...duplicateIssues(input.palletTypes.map((pallet) => pallet.id), "palletTypes", "托盘 ID"));
  issues.push(...duplicateIssues(input.containerTypes.map((container) => container.id), "containerTypes", "柜型 ID"));

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return { valid: errors.length === 0, errors, warnings };
}
