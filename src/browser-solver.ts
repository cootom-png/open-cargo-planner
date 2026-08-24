import type { ContainerType, PalletType, PlanInput, ProductType } from "./domain/model.js";
import { solveLoose } from "./solver/extreme-point.js";
import { solvePallet } from "./solver/pallet-packing.js";
import { solvePalletLoading } from "./solver/pallet-loading.js";
import type { PlanResult, PalletPlanResult } from "./solver/types.js";
import { solverPlacementToSceneItem, type SceneItem } from "./viewer/scene-items.js";

export interface BrowserProductInput {
  name: string;
  sku: string;
  l: number;
  w: number;
  h: number;
  q: number;
  kg: number;
  rotate: boolean;
  side: boolean;
  color: string;
}

export interface BrowserContainerInput {
  id: string;
  code: string;
  l: number;
  w: number;
  h: number;
  kg: number;
  quantity: number;
}

export interface BrowserPalletInput {
  l: number;
  w: number;
  h: number;
  maxH: number;
  gap: number;
  packingMode?: "single-sku" | "mixed-max";
  allowLooseCargo?: boolean;
}

export interface BrowserSolveInput {
  mode: "loose" | "pallet";
  products: BrowserProductInput[];
  container: BrowserContainerInput;
  pallet?: BrowserPalletInput;
}

export interface BrowserSolveResult {
  sceneItems: SceneItem[];
  loadedByProduct: number[];
  warnings: string[];
  metrics: { volumeRatio: number; weightRatio: number; containersUsed: number };
  solverVersion: string;
  palletsUsed: number;
}

function toProducts(input: BrowserSolveInput): ProductType[] {
  return input.products.map((product, index) => ({
    id: `browser-product-${index}`,
    sku: product.sku,
    name: product.name,
    lengthMm: product.l,
    widthMm: product.w,
    heightMm: product.h,
    weightG: Math.round(product.kg * 1000),
    quantity: product.q,
    allowHorizontalRotation: product.rotate,
    allowSideLoading: product.side,
    allowUpsideDown: false,
    mustStayUpright: true,
    stackable: true,
    palletPolicy: input.mode === "pallet" ? "required" : "auto",
    priority: index,
  }));
}

function toContainer(input: BrowserContainerInput): ContainerType {
  return {
    id: input.id,
    code: input.code,
    name: input.code,
    innerLengthMm: input.l,
    innerWidthMm: input.w,
    innerHeightMm: input.h,
    doorWidthMm: input.w,
    doorHeightMm: input.h,
    maxPayloadG: Math.round(input.kg * 1000),
    quantity: input.quantity,
  };
}

function toPallet(input: BrowserPalletInput): PalletType {
  return {
    id: "browser-pallet",
    code: "BROWSER",
    name: "页面输入托盘",
    lengthMm: input.l,
    widthMm: input.w,
    heightMm: 144,
    supplyMode: "unlimited",
    maxLoadG: 1000000,
    maxLoadedHeightMm: Math.max(1, input.maxH - 144),
    overhangMm: 0,
    allowHorizontalRotation: true,
    allowDoubleStack: false,
    minimumGapMm: Math.max(50, input.gap),
  };
}

function toPlanInput(input: BrowserSolveInput): PlanInput {
  return {
    id: "browser-plan",
    mode: input.mode,
    allocationStrategy: "LARGE_FIRST",
    products: toProducts(input),
    palletTypes: input.pallet ? [toPallet(input.pallet)] : [],
    containerTypes: [toContainer(input.container)],
    minimumSupportRatio: 1,
  };
}

function toSceneItems(result: PlanResult, colors: string[]): SceneItem[] {
  return result.placements.map((placement, index) =>
    solverPlacementToSceneItem(placement, colors[placement.productIndex] ?? "#8794a1", index),
  );
}

function loadedByProduct(products: ProductType[], result: PlanResult): number[] {
  const loaded = products.map(() => 0);
  for (const placement of result.placements) loaded[placement.productIndex] = (loaded[placement.productIndex] ?? 0) + 1;
  return loaded;
}

function summarize(result: PlanResult, products: ProductType[], palletsUsed: number, colors: string[]): BrowserSolveResult {
  return {
    sceneItems: toSceneItems(result, colors),
    loadedByProduct: loadedByProduct(products, result),
    warnings: result.warnings,
    metrics: {
      volumeRatio: result.metrics.volumeRatio,
      weightRatio: result.metrics.weightRatio,
      containersUsed: result.metrics.containersUsed,
    },
    solverVersion: result.solverVersion,
    palletsUsed,
  };
}

export function solveForBrowser(input: BrowserSolveInput): BrowserSolveResult {
  const planInput = toPlanInput(input);
  const colors = input.products.map((product) => product.color);

  if (input.mode === "loose") {
    const result = solveLoose(planInput);
    return summarize(result, planInput.products, 0, colors);
  }

  const palletResult: PalletPlanResult = solvePallet(planInput, {
    mode: input.pallet?.packingMode ?? "mixed-max",
    allowLooseCargo: input.pallet?.allowLooseCargo ?? true,
  });
  const result = solvePalletLoading(palletResult.pallets, planInput);
  return summarize(result, planInput.products, palletResult.metrics.palletsUsed, colors);
}
