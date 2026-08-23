import type { Orientation, PalletType, PlanInput } from "../domain/model.js";
import { generateOrientations } from "../domain/orientations.js";
import type {
  PalletItemPlacement,
  PalletLoadUnit,
  PalletPlanResult,
  UnloadedItem,
} from "./types.js";

export interface PalletPackingOptions {
  /** 是否启用层间 90° 交错（默认 true）。 */
  layerInterlock?: boolean;
  /** 单托盘最大码放件数保护。 */
  maxItemsPerPallet?: number;
}

interface OptionsRequired {
  layerInterlock: boolean;
  maxItemsPerPallet: number;
}

interface Box3 {
  x: number;
  y: number;
  z: number;
  length: number;
  width: number;
  height: number;
  x2: number;
  y2: number;
  z2: number;
}

interface PendingUnit {
  productIndex: number;
  sku: string;
  weightG: number;
  quantity: number;
}

const EPS = 1e-6;

function makeBox(x: number, y: number, z: number, length: number, width: number, height: number): Box3 {
  return { x, y, z, length, width, height, x2: x + length, y2: y + width, z2: z + height };
}

function normalizeOptions(options?: PalletPackingOptions): OptionsRequired {
  return {
    layerInterlock: options?.layerInterlock ?? true,
    maxItemsPerPallet: options?.maxItemsPerPallet ?? 2000,
  };
}

export class PalletPackingSolver {
  private options: OptionsRequired;

  constructor(options?: PalletPackingOptions) {
    this.options = normalizeOptions(options);
  }

  solve(input: PlanInput): PalletPlanResult {
    const warnings: string[] = [];
    const orientCache = new Map<number, Orientation[]>();
    input.products.forEach((_, i) => orientCache.set(i, generateOrientations(input.products[i]!)));

    // 托盘映射：为每个可打托产品选定推荐托盘类型下标
    const palletIndexFor = new Map<number, number>();
    const palletizable: number[] = [];
    input.products.forEach((p, pi) => {
      if (p.quantity <= 0) return;
      if (p.palletPolicy === "forbidden") return;
      const ids = p.eligiblePalletTypeIds ?? input.palletTypes.map((pt) => pt.id);
      const idx = input.palletTypes.findIndex((pt) => ids.includes(pt.id));
      if (idx >= 0) {
        palletIndexFor.set(pi, idx);
        palletizable.push(pi);
      } else if (p.palletPolicy === "required") {
        warnings.push(`SKU ${p.sku} 必须打托但没有可用托盘，跳过。`);
      }
    });
    // required 优先，体积降序
    palletizable.sort((a, b) => {
      const pa = input.products[a]!;
      const pb = input.products[b]!;
      if (pa.palletPolicy === "required" && pb.palletPolicy !== "required") return -1;
      if (pb.palletPolicy === "required" && pa.palletPolicy !== "required") return 1;
      const va = pa.lengthMm * pa.widthMm * pa.heightMm;
      const vb = pb.lengthMm * pb.widthMm * pb.heightMm;
      return vb - va || a - b;
    });

    const pending: PendingUnit[] = input.products.map((p, idx) => ({
      productIndex: idx,
      sku: p.sku,
      weightG: p.weightG,
      quantity: p.quantity,
    }));

    const pallets: PalletLoadUnit[] = [];

    // 循环：每次尝试开一个新托盘并尽可能填满
    /* eslint-disable @typescript-eslint/no-unused-vars */
    let guard = 0;
    const maxPallets = 100000 + input.products.reduce((s, p) => s + p.quantity, 0);
    while (guard < maxPallets) {
      guard += 1;
      // 找一个仍有需求、可打托的产品作为当前托盘主类型
      let chosenIdx = -1;
      for (const pi of palletizable) {
        if (pending[pi]!.quantity > 0) {
          chosenIdx = palletIndexFor.get(pi)!;
          break;
        }
      }
      if (chosenIdx < 0) break;
      const palletType = input.palletTypes[chosenIdx]!;

      const unit = this.buildPalletUnit(input, pending, chosenIdx, palletType, orientCache, warnings);
      if (unit.items.length === 0) {
        // 该托盘无法再塞入任何产品（产品耗尽或托盘过小）
        if (pending.every((u) => u.quantity <= 0 || input.products[u.productIndex]!.palletPolicy === "forbidden")) break;
        // 可能是托盘类型不合适，标记该托盘已无可码产品 → 交由未码处理
        break;
      }
      pallets.push(unit);
      // 扣减数量
      for (const it of unit.items) {
        const rec = pending[it.productIndex];
        if (rec) rec.quantity -= 1;
      }
    }

    const unloaded: UnloadedItem[] = pending
      .filter((u) => u.quantity > 0)
      .map((u) => ({ sku: u.sku, productIndex: u.productIndex, remaining: u.quantity }));

    // 指标
    const boxVolume = pallets.reduce(
      (s, pl) => s + pl.items.reduce((ss, it) => ss + it.orientation.lengthMm * it.orientation.widthMm * it.orientation.heightMm, 0),
      0,
    );
    const palletCapacityVolume = pallets.reduce(
      (s, pl) => s + pl.palletLengthMm * pl.palletWidthMm * Math.max(0, pl.totalHeightMm - pl.palletHeightMm),
      0,
    );
    const totalWeight = pallets.reduce((s, pl) => s + pl.totalWeightG, 0);
    const palletsByType = new Map<string, number>();
    for (const pl of pallets) palletsByType.set(pl.palletTypeId, (palletsByType.get(pl.palletTypeId) ?? 0) + 1);

    return {
      pallets,
      unloaded,
      metrics: {
        palletsUsed: pallets.length,
        totalVolumeMm3: boxVolume,
        volumeRatio: palletCapacityVolume > 0 ? boxVolume / palletCapacityVolume : 0,
        totalWeightG: totalWeight,
        weightRatio: 0,
        palletsByType: [...palletsByType.entries()].map(([palletTypeId, used]) => ({ palletTypeId, used })),
      },
      warnings,
      solverVersion: "pallet-layer/0.1.0",
    };
  }

  private buildPalletUnit(
    input: PlanInput,
    pending: PendingUnit[],
    palletTypeIndex: number,
    pallet: PalletType,
    orientCache: Map<number, Orientation[]>,
    warnings: string[],
  ): PalletLoadUnit {
    const deckHeight = pallet.heightMm;
    const maxLoadedHeight = pallet.maxLoadedHeightMm;
    const maxLoad = pallet.maxLoadG;
    const palletL = pallet.lengthMm;
    const palletW = pallet.widthMm;

    // 托盘允许的水平旋转：托盘自身可在 y 轴翻转（长宽互换），此处固定以为长、宽方向，简化。
    const layerL = palletL;
    const layerW = palletW;

    const items: PalletItemPlacement[] = [];
    const placedBoxes: Box3[] = [];
    const skuCount = new Map<string, number>();
    let cargoWeight = 0;
    let itemCount = 0;
    let layerIndex = 0;
    let currentTop = 0; // 当前已码放高度（相对托盘上表面）

    const placedByPending = new Map<number, number>();
    // 逐层：每层选择一个"层高"，用 shelf 二维布局铺满一层
    while (itemCount < this.options.maxItemsPerPallet) {
      // 收集本层可行候选（还有需求、可平放、不超重超高）
      type Cand = { pendingIndex: number; orientation: Orientation; weightG: number };
      let candidates: Cand[] = [];
      for (let pi = 0; pi < pending.length; pi += 1) {
        const u = pending[pi]!;
        if (u.quantity <= 0) continue;
        const o = orientCache.get(u.productIndex) ?? [];
        for (const ori of o) {
          if (ori.lengthMm <= layerL + EPS && ori.widthMm <= layerW + EPS) {
            // 竖直高度为该朝向的高度
            if (currentTop + ori.heightMm > maxLoadedHeight - deckHeight + EPS) continue;
            if (cargoWeight + u.weightG > maxLoad + EPS) continue;
            candidates.push({ pendingIndex: pi, orientation: ori, weightG: u.weightG });
          }
        }
      }
      // 去重：同一产品同一几何尺寸只保留一个朝向（按尺寸键去重），保留高度最小的平放朝向；
      // 但允许同一产品的不同平放朝向（如 LWH 与 WLH）都存在，以便层内长宽方向灵活排布。
      const seenOrient = new Set<string>();
      const dedup: Cand[] = [];
      for (const c of candidates) {
        const key = `${c.orientation.lengthMm}:${c.orientation.widthMm}:${c.orientation.heightMm}`;
        if (seenOrient.has(key)) continue;
        seenOrient.add(key);
        dedup.push(c);
      }
      candidates = dedup;

      if (candidates.length === 0) break;

      // 层高 = 本层候选中最高的高度（等高整层码放）；取最高箱高作层高以整齐铺放
      const layerHeight = Math.max(...candidates.map((c) => c.orientation.heightMm));
      // 本层只放高度 == layerHeight 的箱（等高），保证层顶平整、层间交错有效
      const layerCandidates = candidates.filter((c) => Math.abs(c.orientation.heightMm - layerHeight) <= EPS);
      if (layerCandidates.length === 0) {
        // 防御：退化为最矮候选单层
        const min = candidates.sort((a, b) => a.orientation.heightMm - b.orientation.heightMm)[0]!;
        layerCandidates.push(min);
        // 重新计算层高
        // layerHeight 已取最大，这里用 layerCandidates[0] 高度
      }
      const effHeight = Math.max(...layerCandidates.map((c) => c.orientation.heightMm));
      // shelf 行沿托盘宽方向推进，行高取本层最大箱宽（y 方向尺寸），保证同层不重叠
      const effRowWidth = Math.max(...layerCandidates.map((c) => c.orientation.widthMm));

      if (currentTop + effHeight > maxLoadedHeight - deckHeight + EPS) break;

      // shelf 布局（层内二维贪心，x 从托盘左边缘铺满）
      const placement: Array<{ cand: Cand; box: Box3 }> = [];
      // 层间交错：奇数层对候选顺序倒序，形成砖砌错位；x 仍从 0 起避免浪费
      const orderedLayerCandidates = [...layerCandidates];
      if (this.options.layerInterlock && layerIndex % 2 === 1) orderedLayerCandidates.reverse();
      let y = 0;
      let placedThisLayer = 0;
      let progress = true;
      while (progress && y + EPS < layerW) {
        progress = false;
        let x = 0;
        let reachedEnd = false;
        // 本 shelf 行高度 = effHeight（等高层）
        while (!reachedEnd) {
          let fitted = false;
          for (const cand of orderedLayerCandidates) {
            const alreadyPlaced = placedByPending.get(cand.pendingIndex) ?? 0;
            const remaining = pending[cand.pendingIndex]!.quantity;
            if (alreadyPlaced >= remaining) continue;
            const box = makeBox(x, y, currentTop, cand.orientation.lengthMm, cand.orientation.widthMm, effHeight);
            if (x + box.length > layerL + EPS || y + box.width > layerW + EPS) continue;
            if (placedBoxes.some((pb) => boxOverlap(pb, box))) continue;
            if (cargoWeight + cand.weightG > maxLoad + EPS) break;
            // 放入
            placement.push({ cand, box });
            placedByPending.set(cand.pendingIndex, alreadyPlaced + 1);
            placedBoxes.push(box);
            cargoWeight += cand.weightG;
            x += box.length + 0;
            placedThisLayer += 1;
            fitted = true;
            progress = true;
            if (x + EPS >= layerL) reachedEnd = true;
            break;
          }
          if (!fitted || reachedEnd) {
            if (!fitted) reachedEnd = true;
            break;
          }
        }
        // 下一 shelf
        y += effRowWidth + 5;
      }

      if (placedThisLayer === 0) {
        // 无法摆出任何一层 → 停止
        break;
      }

      // 提交本层
      for (const pl of placement) {
        const pendingRec = pending[pl.cand.pendingIndex]!;
        const sku = pendingRec.sku;
        items.push({
          productIndex: pl.cand.pendingIndex,
          sku,
          x: pl.box.x,
          y: pl.box.y,
          z: pl.box.z,
          orientation: pl.cand.orientation,
          layerIndex,
        });
        skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
        itemCount += 1;
      }
      currentTop += effHeight;
      layerIndex += 1;
    }

    const boxVolume = items.reduce((s, it) => s + it.orientation.lengthMm * it.orientation.widthMm * it.orientation.heightMm, 0);
    const capacityDenom = layerL * layerW * currentTop;

    return {
      palletTypeIndex,
      palletTypeId: pallet.id,
      palletCode: pallet.code,
      palletLengthMm: pallet.lengthMm,
      palletWidthMm: pallet.widthMm,
      palletHeightMm: pallet.heightMm,
      skuSummary: [...skuCount.entries()].map(([sku, quantity]) => {
        const productIndex = items.find((i) => i.sku === sku)!.productIndex;
        return { sku, productIndex, quantity };
      }),
      items,
      totalHeightMm: deckHeight + currentTop,
      totalWeightG: cargoWeight + (pallet.emptyWeightG ?? 0),
      layerCount: layerIndex,
      utilization: capacityDenom > 0 ? boxVolume / capacityDenom : 0,
    };
  }
}

function boxOverlap(a: Box3, b: Box3): boolean {
  return (
    a.x < b.x2 - EPS && a.x2 > b.x + EPS &&
    a.y < b.y2 - EPS && a.y2 > b.y + EPS &&
    a.z < b.z2 - EPS && a.z2 > b.z + EPS
  );
}

/** 便捷入口。 */
export function solvePallet(input: PlanInput, options?: PalletPackingOptions): PalletPlanResult {
  return new PalletPackingSolver(options).solve(input);
}
