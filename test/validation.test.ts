import assert from "node:assert/strict";
import test from "node:test";
import { validatePlanInput, type PlanInput } from "../src/index.js";

const validPlan = (): PlanInput => ({
  id: "plan-1",
  mode: "pallet",
  allocationStrategy: "LARGE_FIRST",
  minimumSupportRatio: 1,
  products: [{
    id: "product-1",
    sku: "SKU-1",
    name: "测试产品",
    lengthMm: 600,
    widthMm: 400,
    heightMm: 300,
    weightG: 10_000,
    quantity: 20,
    allowHorizontalRotation: true,
    allowSideLoading: false,
    allowUpsideDown: false,
    mustStayUpright: false,
    stackable: true,
    maxTopLoadG: 50_000,
    palletPolicy: "required",
    eligiblePalletTypeIds: ["pallet-1"],
    priority: 1,
  }],
  palletTypes: [{
    id: "pallet-1",
    code: "PL-1200",
    name: "1200 × 1000 卡板",
    lengthMm: 1200,
    widthMm: 1000,
    heightMm: 150,
    supplyMode: "unlimited",
    maxLoadG: 1_000_000,
    maxLoadedHeightMm: 1800,
    overhangMm: 0,
    allowHorizontalRotation: true,
    allowDoubleStack: false,
    minimumGapMm: 50,
  }],
  containerTypes: [{
    id: "40hq",
    code: "40HQ",
    name: "40HQ",
    innerLengthMm: 12032,
    innerWidthMm: 2352,
    innerHeightMm: 2698,
    doorWidthMm: 2340,
    doorHeightMm: 2585,
    maxPayloadG: 26_500_000,
    quantity: 1,
  }],
});

test("有效方案通过校验", () => {
  const report = validatePlanInput(validPlan());
  assert.equal(report.valid, true);
  assert.deepEqual(report.errors, []);
});

test("拒绝低于 50 mm 的托盘净间距", () => {
  const plan = validPlan();
  plan.palletTypes[0]!.minimumGapMm = 49;
  const report = validatePlanInput(plan);
  assert.equal(report.valid, false);
  assert.equal(report.errors.some((issue) => issue.code === "PALLET_GAP_TOO_SMALL"), true);
});

test("拒绝重复 SKU、无效尺寸和未知托盘引用", () => {
  const plan = validPlan();
  plan.products.push({
    ...plan.products[0]!,
    id: "product-2",
    lengthMm: 0,
    eligiblePalletTypeIds: ["missing-pallet"],
  });
  const report = validatePlanInput(plan);
  const codes = new Set(report.errors.map((issue) => issue.code));
  assert.equal(codes.has("DUPLICATE_VALUE"), true);
  assert.equal(codes.has("POSITIVE_INTEGER_REQUIRED"), true);
  assert.equal(codes.has("UNKNOWN_PALLET_TYPE"), true);
});

test("散装模式不强制要求托盘", () => {
  const plan = validPlan();
  plan.mode = "loose";
  plan.palletTypes = [];
  plan.products[0]!.palletPolicy = "forbidden";
  plan.products[0]!.eligiblePalletTypeIds = [];
  const report = validatePlanInput(plan);
  assert.equal(report.valid, true);
});

test("必须正放与侧装或倒置设置冲突", () => {
  const plan = validPlan();
  plan.products[0]!.mustStayUpright = true;
  plan.products[0]!.allowSideLoading = true;
  const report = validatePlanInput(plan);
  assert.equal(report.errors.some((issue) => issue.code === "UPRIGHT_RULE_CONFLICT"), true);
});

test("必须打托的产品至少能放入一种适用托盘", () => {
  const plan = validPlan();
  plan.products[0]!.lengthMm = 1300;
  plan.products[0]!.widthMm = 1100;
  plan.products[0]!.heightMm = 1900;
  const report = validatePlanInput(plan);
  assert.equal(report.errors.some((issue) => issue.code === "NO_FITTING_PALLET"), true);
});
