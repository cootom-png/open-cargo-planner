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
  /** 稳定性级别：严格/平衡/宽松（默认 balanced）*/
  stabilityLevel?: 'strict' | 'balanced' | 'relaxed';
  /** 最小支撑率（0-1）。严格模式默认 0.8，平衡模式 0.6，宽松模式 0.4 */
  minSupportRatio?: number;
}

interface OptionsRequired {
  layerInterlock: boolean;
  maxItemsPerPallet: number;
  stabilityLevel: 'strict' | 'balanced' | 'relaxed';
  minSupportRatio: number;
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
  const stabilityLevel = options?.stabilityLevel ?? 'balanced';
  let defaultMinSupportRatio: number;
  
  if (stabilityLevel === 'strict') {
    defaultMinSupportRatio = 0.8;
  } else if (stabilityLevel === 'relaxed') {
    defaultMinSupportRatio = 0.4;
  } else {
    defaultMinSupportRatio = 0.6;
  }
  
  return {
    layerInterlock: options?.layerInterlock ?? true,
    maxItemsPerPallet: options?.maxItemsPerPallet ?? 2000,
    stabilityLevel,
    minSupportRatio: options?.minSupportRatio ?? defaultMinSupportRatio,
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
    // required 优先，体积降序（大箱优先）
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
    const skuFirstLayer = new Map<string, number>(); // 记录每个SKU首次出现的层
    let cargoWeight = 0;
    let itemCount = 0;
    let layerIndex = 0;
    let currentTop = 0; // 当前已码放高度（相对托盘上表面）

    const placedByPending = new Map<number, number>();
    
    // 检测多规格场景：统计有需求的不同产品数
    const activeProducts = pending.filter((u) => u.quantity > 0).length;
    const useInterlock = this.options.layerInterlock && activeProducts === 1;
    
    // 逐层：每层选择一个"层高"，用 shelf 二维布局铺满一层
    while (itemCount < this.options.maxItemsPerPallet) {
      // 收集本层可行候选（还有需求、可平放、不超重超高）
      type Cand = { pendingIndex: number; orientation: Orientation; weightG: number; score: number };
      const candidates: Cand[] = [];
      for (let pi = 0; pi < pending.length; pi += 1) {
        const u = pending[pi]!;
        if (u.quantity <= 0) continue;
        const o = orientCache.get(u.productIndex) ?? [];
        
        // 为每个产品选择最优朝向
        let bestOri: Orientation | null = null;
        let bestScore = -Infinity;
        
        for (const ori of o) {
          if (ori.lengthMm <= layerL + EPS && ori.widthMm <= layerW + EPS) {
            // 竖直高度为该朝向的高度
            if (currentTop + ori.heightMm > maxLoadedHeight - deckHeight + EPS) continue;
            if (cargoWeight + u.weightG > maxLoad + EPS) continue;
            
            // 朝向评分：优先长边沿托盘长方向、平放优先、能整除托盘尺寸加分
            const score = this.scoreOrientation(ori, layerL, layerW);
            if (score > bestScore) {
              bestScore = score;
              bestOri = ori;
            }
          }
        }
        
        // 只保留每个产品的最优朝向
        if (bestOri) {
          candidates.push({ pendingIndex: pi, orientation: bestOri, weightG: u.weightG, score: bestScore });
        }
      }

      if (candidates.length === 0) break;

      // 智能混层策略：选择主导产品 + 允许小产品回填
      // 1. 按体积降序排序候选（大箱优先作为本层主导，确保稳定性）
      candidates.sort((a, b) => {
        const volA = a.orientation.lengthMm * a.orientation.widthMm * a.orientation.heightMm;
        const volB = b.orientation.lengthMm * b.orientation.widthMm * b.orientation.heightMm;
        return volB - volA;
      });
      
      // 选择体积最大且剩余需求最多的产品作为本层主导
      let mainCand: Cand | null = null;
      for (const cand of candidates) {
        const remaining = pending[cand.pendingIndex]!.quantity - (placedByPending.get(cand.pendingIndex) ?? 0);
        if (remaining > 0) {
          mainCand = cand;
          break;
        }
      }
      
      if (!mainCand) break;
      
      // 2. 筛选可回填的小产品（体积 < 主导产品30%，高度兼容±20mm）
      const mainVolume = mainCand.orientation.lengthMm * mainCand.orientation.widthMm * mainCand.orientation.heightMm;
      const fillCands: Cand[] = [];
      for (const cand of candidates) {
        if (cand === mainCand) continue;
        const candVolume = cand.orientation.lengthMm * cand.orientation.widthMm * cand.orientation.heightMm;
        if (candVolume > mainVolume * 0.3) continue; // 体积过大
        if (Math.abs(cand.orientation.heightMm - mainCand.orientation.heightMm) > 20) continue; // 高度不兼容
        const remaining = pending[cand.pendingIndex]!.quantity - (placedByPending.get(cand.pendingIndex) ?? 0);
        if (remaining > 0) fillCands.push(cand);
      }
      
      // 3. 按剩余需求降序排序回填候选
      fillCands.sort((a, b) => {
        const remA = pending[a.pendingIndex]!.quantity - (placedByPending.get(a.pendingIndex) ?? 0);
        const remB = pending[b.pendingIndex]!.quantity - (placedByPending.get(b.pendingIndex) ?? 0);
        return remB - remA;
      });
      
      // 本层候选：主导产品在前，回填产品在后
      const layerCandidates = [mainCand, ...fillCands];
      const effHeight = mainCand.orientation.heightMm;
      const effRowWidth = mainCand.orientation.widthMm;

      if (currentTop + effHeight > maxLoadedHeight - deckHeight + EPS) break;

      // shelf 布局（层内二维贪心，x 从托盘左边缘铺满）
      const placement: Array<{ cand: Cand; box: Box3 }> = [];
      // 层间交错：仅在单一产品场景下启用
      const orderedLayerCandidates = [...layerCandidates];
      if (useInterlock && layerIndex % 2 === 1) orderedLayerCandidates.reverse();
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
            const box = makeBox(x, y, currentTop, cand.orientation.lengthMm, cand.orientation.widthMm, cand.orientation.heightMm);
            if (x + box.length > layerL + EPS || y + box.width > layerW + EPS) continue;
            if (placedBoxes.some((pb) => boxOverlap(pb, box))) continue;
            if (cargoWeight + cand.weightG > maxLoad + EPS) break;
            
            // 稳定性检查：当前箱体的支撑率
            if (currentTop > 0) {
              const supportRatio = this.calculateSupportRatio(box, placedBoxes);
              if (supportRatio < this.options.minSupportRatio - EPS) {
                continue; // 支撑不足，跳过该位置
              }
            }
            
            // 回填数量控制：回填产品不超过本层总数的20%
            const isMainProduct = cand === mainCand;
            if (!isMainProduct) {
              const mainProductCount = placement.filter((p) => p.cand === mainCand).length;
              const fillProductCount = placement.filter((p) => p.cand !== mainCand).length;
              if (fillProductCount >= mainProductCount * 0.25) continue; // 回填已达上限
            }
            
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
        // 下一 shelf：动态间隙调整
        const gap = Math.max(2, Math.min(5, Math.min(mainCand.orientation.lengthMm, mainCand.orientation.widthMm) * 0.01));
        y += effRowWidth + gap;
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
        if (!skuFirstLayer.has(sku)) skuFirstLayer.set(sku, layerIndex);
        itemCount += 1;
      }
      currentTop += effHeight;
      layerIndex += 1;
    }

    // 计算各层利用率统计
    const layerUtilizations: Array<{ layerIndex: number; utilization: number; itemCount: number; mainSku: string }> = [];
    for (let i = 0; i < layerIndex; i++) {
      const layerItems = items.filter((it) => it.layerIndex === i);
      if (layerItems.length === 0) continue;
      
      const layerVolume = layerItems.reduce((s, it) => 
        s + it.orientation.lengthMm * it.orientation.widthMm * it.orientation.heightMm, 0
      );
      const layerHeight = Math.max(...layerItems.map((it) => it.z + it.orientation.heightMm)) - 
                          Math.min(...layerItems.map((it) => it.z));
      const layerCapacity = layerL * layerW * layerHeight;
      
      // 找出该层主导 SKU（数量最多）
      const skuCounts = new Map<string, number>();
      for (const it of layerItems) {
        skuCounts.set(it.sku, (skuCounts.get(it.sku) ?? 0) + 1);
      }
      const mainSku = [...skuCounts.entries()].reduce((a, b) => a[1] > b[1] ? a : b)[0];
      
      layerUtilizations.push({
        layerIndex: i,
        utilization: layerCapacity > 0 ? layerVolume / layerCapacity : 0,
        itemCount: layerItems.length,
        mainSku,
      });
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
      layerUtilizations,
    };
  }

  /**
   * 朝向评分函数：为每个朝向计算优先级分数
   * - 优先长边沿托盘长方向（减少行数）
   * - 优先平放（高度小）
   * - 优先能整除托盘尺寸的朝向
   */
  private scoreOrientation(ori: Orientation, palletL: number, palletW: number): number {
    let score = 0;
    
    // 优先长边沿托盘长方向（长边作为 length）
    if (ori.lengthMm >= ori.widthMm) score += 100;
    
    // 优先平放（高度小的朝向）
    score += (1000 - ori.heightMm) * 0.1;
    
    // 优先能整除托盘尺寸的朝向（减少空间浪费）
    const remainderL = palletL % ori.lengthMm;
    const remainderW = palletW % ori.widthMm;
    if (remainderL < 10) score += 50;
    if (remainderW < 10) score += 50;
    
    // 优先能放置更多数量的朝向（面积利用率）
    const countX = Math.floor(palletL / ori.lengthMm);
    const countY = Math.floor(palletW / ori.widthMm);
    score += (countX * countY) * 0.5;
    
    return score;
  }

  /**
   * 计算箱体的支撑率：底面被下层箱体支撑的面积比例
   * @param box 待检查的箱体
   * @param placedBoxes 已放置的所有箱体
   * @returns 支撑率 (0-1)
   */
  private calculateSupportRatio(box: Box3, placedBoxes: Box3[]): number {
    // 找出所有在当前箱体正下方的箱体（z2 = box.z）
    const supportingBoxes = placedBoxes.filter((pb) => Math.abs(pb.z2 - box.z) < EPS);
    
    if (supportingBoxes.length === 0) {
      // 没有支撑箱体（应该是托盘表面），返回 1.0
      return 1.0;
    }
    
    // 计算底面被支撑的面积
    const boxBottomArea = box.length * box.width;
    let supportedArea = 0;
    
    for (const sb of supportingBoxes) {
      // 计算水平重叠区域
      const overlapX1 = Math.max(box.x, sb.x);
      const overlapX2 = Math.min(box.x2, sb.x2);
      const overlapY1 = Math.max(box.y, sb.y);
      const overlapY2 = Math.min(box.y2, sb.y2);
      
      if (overlapX2 > overlapX1 + EPS && overlapY2 > overlapY1 + EPS) {
        const overlapArea = (overlapX2 - overlapX1) * (overlapY2 - overlapY1);
        supportedArea += overlapArea;
      }
    }
    
    return boxBottomArea > EPS ? Math.min(1.0, supportedArea / boxBottomArea) : 0;
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
