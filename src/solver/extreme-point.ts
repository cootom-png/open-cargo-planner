import type { ContainerType, Orientation, PlanInput } from "../domain/model.js";
import { generateOrientations } from "../domain/orientations.js";
import type { Placement, PlanResult, UnloadedItem } from "./types.js";

/** 三维轴对齐包围盒。 */
interface Box3 {
  x: number;
  y: number;
  z: number;
  x2: number;
  y2: number;
  z2: number;
  length: number;
  width: number;
  height: number;
}

interface Space extends Box3 {}

/** 已放置货物的运行时记录（含箱体重 与来源产品索引）。 */
interface PlacedRecord {
  box: Box3;
  productIndex: number;
  weightG: number;
}

const EPS = 1e-6;

function makeBox(x: number, y: number, z: number, length: number, width: number, height: number): Box3 {
  return { x, y, z, x2: x + length, y2: y + width, z2: z + height, length, width, height };
}

function overlaps(a: Box3, b: Box3): boolean {
  return (
    a.x < b.x2 - EPS && a.x2 > b.x + EPS &&
    a.y < b.y2 - EPS && a.y2 > b.y + EPS &&
    a.z < b.z2 - EPS && a.z2 > b.z + EPS
  );
}

function contains(inner: Box3, outer: Box3): boolean {
  return (
    inner.x >= outer.x - EPS && inner.x2 <= outer.x2 + EPS &&
    inner.y >= outer.y - EPS && inner.y2 <= outer.y2 + EPS &&
    inner.z >= outer.z - EPS && inner.z2 <= outer.z2 + EPS
  );
}

/**
 * 用已放置箱 occ 从自由空间 free 中切分出互不重叠的最大残块（3 残块剥壳法）。
 * occ 完全落在 free 内（由调用方保证）。返回至多 3 块，互不重叠：
 *   R  = occ 右侧全长条
 *   Fr = occ 前方（y 增大方向）在 x<occ 区的条
 *   T  = occ 上方在 x<occ 且 y<occ 区的条
 * 该法既保证无重叠碎片，也把空间数增长控制在每次 +≤3。
 */
function splitSpace(free: Space, occ: Box3): Space[] {
  const pieces: Space[] = [];
  // R：右侧全长条（y、z 沿用 free 全区间）
  if (occ.x2 < free.x2 - EPS) {
    pieces.push(makeBox(occ.x2, free.y, free.z, free.x2 - occ.x2, free.width, free.height));
  }
  // Fr：前方条，x 取 [free.x, occ.x2]，y 从 occ.y2 起
  if (occ.y2 < free.y2 - EPS) {
    const xStart = free.x;
    const xEnd = Math.min(free.x2, occ.x2);
    if (xEnd - xStart > EPS) {
      pieces.push(makeBox(xStart, occ.y2, free.z, xEnd - xStart, free.y2 - occ.y2, free.height));
    }
  } else if (occ.y2 >= free.y2 - EPS && occ.x2 < free.x2 - EPS) {
    // occ 占满 y 方向，则前方条退化为右侧条已覆盖，无需额外块
  }
  // T：上方条，x 取 [free.x, occ.x2]，y 取 [free.y, occ.y2]
  if (occ.z2 < free.z2 - EPS) {
    const xStart = free.x;
    const xEnd = Math.min(free.x2, occ.x2);
    const yStart = free.y;
    const yEnd = Math.min(free.y2, occ.y2);
    if (xEnd - xStart > EPS && yEnd - yStart > EPS) {
      pieces.push(makeBox(xStart, yStart, occ.z2, xEnd - xStart, yEnd - yStart, free.z2 - occ.z2));
    }
  }
  return pieces.filter((p) => p.length > EPS && p.width > EPS && p.height > EPS);
}

export interface SolverOptions {
  /** 是否执行支撑率校验（默认 true）。 */
  enforceSupport?: boolean;
  /** 是否执行顶部承重/堆叠层数校验（默认 true）。 */
  enforceTopLoad?: boolean;
  /** 单容器最大放置数保护。 */
  maxPlacementsPerContainer?: number;
}

interface SolverOptionsRequired {
  enforceSupport: boolean;
  enforceTopLoad: boolean;
  maxPlacementsPerContainer: number;
}

interface PendingItem {
  productIndex: number;
  sku: string;
  weightG: number;
  quantity: number;
}

interface ContainerRun {
  type: ContainerType;
  spaces: Space[];
  placed: PlacedRecord[];
  usedWeightG: number;
}

function normalizeOptions(options?: SolverOptions): SolverOptionsRequired {
  return {
    enforceSupport: options?.enforceSupport ?? true,
    enforceTopLoad: options?.enforceTopLoad ?? true,
    maxPlacementsPerContainer: options?.maxPlacementsPerContainer ?? 50000,
  };
}

export class LoosePackingSolver {
  private options: SolverOptionsRequired;

  constructor(options?: SolverOptions) {
    this.options = normalizeOptions(options);
  }

  solve(input: PlanInput): PlanResult {
    if (input.products.length === 0) throw new Error("PlanInput 至少需要一个产品。");
    if (input.containerTypes.length === 0) throw new Error("PlanInput 至少需要一种柜型。");

    // 组装待装单元，按体积降序
    const pending: PendingItem[] = input.products.map((p, productIndex) => ({
      productIndex,
      sku: p.sku,
      weightG: p.weightG,
      quantity: p.quantity,
    }));
    // 缓存每种产品的朝向
    const orientCache = new Map<number, Orientation[]>();
    input.products.forEach((p, i) => orientCache.set(i, generateOrientations(p)));

    // 展开容器序列
    const containerSequence: { containerIndex: number; type: ContainerType }[] = [];
    let seq = 0;
    for (const type of input.containerTypes) {
      for (let q = 0; q < type.quantity; q += 1) {
        containerSequence.push({ containerIndex: seq, type });
        seq += 1;
      }
    }
    const totalContainerVolume = containerSequence.reduce(
      (s, c) => s + c.type.innerLengthMm * c.type.innerWidthMm * c.type.innerHeightMm,
      0,
    );
    const totalContainerPayload = containerSequence.reduce((s, c) => s + c.type.maxPayloadG, 0);

    const allPlacements: Placement[] = [];
    const remaining = pending.map((p) => ({ ...p }));

    for (const { containerIndex, type } of containerSequence) {
      if (remaining.every((r) => r.quantity <= 0)) break;
      const run: ContainerRun = {
        type,
        spaces: [makeBox(0, 0, 0, type.innerLengthMm, type.innerWidthMm, type.innerHeightMm)],
        placed: [],
        usedWeightG: 0,
      };
      let placedInContainer = 0;

      // 循环放置直到本容器无法再装任何未装箱。
      // 采用"列式批量放置"：对每个 (空间, 朝向)，在该空间左下前角沿 Z 轴连续堆叠
      // 一列相同尺寸的同款箱（天然 100% 支撑），一次放置整列，显著提升紧凑度与速度。
      let progressed = true;
      while (progressed && placedInContainer < this.options.maxPlacementsPerContainer) {
        progressed = false;
        let bestCol: {
          box: Box3;
          orientation: Orientation;
          height: number;
          count: number;
          productIndex: number;
        } | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (let si = 0; si < run.spaces.length; si += 1) {
          const space = run.spaces[si]!;
          // 该空间仍至少能被一个产品及朝向利用？快速预筛
          let spaceFeasible = false;
          for (let ri = 0; ri < remaining.length; ri += 1) {
            const item = remaining[ri]!;
            if (item.quantity <= 0) continue;
            const orientations = orientCache.get(item.productIndex) ?? [];
            for (const orient of orientations) {
              if (orient.lengthMm <= space.length + EPS && orient.widthMm <= space.width + EPS && orient.heightMm <= space.height + EPS) {
                spaceFeasible = true;
                break;
              }
            }
            if (spaceFeasible) break;
          }
          if (!spaceFeasible) continue;

          for (let ri = 0; ri < remaining.length; ri += 1) {
            const item = remaining[ri]!;
            if (item.quantity <= 0) continue;
            const product = input.products[item.productIndex]!;
            const orientations = orientCache.get(item.productIndex) ?? [];
            for (const orient of orientations) {
              if (orient.lengthMm > space.length + EPS || orient.widthMm > space.width + EPS) continue;
              // 计算在该空间角垂直堆叠本朝向可放的最大层数
              const layerHeight = orient.heightMm;
              const maxStack = Math.floor(space.height / layerHeight + EPS);
              if (maxStack < 1) continue;
              let layerCount = Math.min(item.quantity, maxStack);

              // 支撑（首层贴地或贴下方箱顶）
              if (this.options.enforceSupport) {
                const firstBox = makeBox(space.x, space.y, space.z, orient.lengthMm, orient.widthMm, orient.heightMm);
                if (!hasSupport(firstBox, run.placed, input.minimumSupportRatio)) continue;
              }
              // 重量
              if (run.usedWeightG + item.weightG > type.maxPayloadG) continue;
              // 顶部承重：最底层箱体承受其上 (layerCount-1) 层的总重，须小于等于 maxTopLoadG
              if (this.options.enforceTopLoad && product.maxTopLoadG !== undefined) {
                const maxByLoad = product.maxTopLoadG / item.weightG + 1;
                layerCount = Math.min(layerCount, Math.max(1, Math.floor(maxByLoad)));
              }
              if (layerCount < 1) continue;

              const colHeight = layerCount * layerHeight;
              const colBox = makeBox(space.x, space.y, space.z, orient.lengthMm, orient.widthMm, colHeight);
              // 列不得超出空间与容器
              if (
                colBox.x2 > space.x2 + EPS || colBox.y2 > space.y2 + EPS || colBox.z2 > space.z2 + EPS
              ) continue;

              const colVol = colBox.length * colBox.width * colBox.height;
              if (colVol > bestScore) {
                bestScore = colVol;
                bestCol = { box: colBox, orientation: orient, height: layerHeight, count: layerCount, productIndex: item.productIndex };
              }
            }
          }
        }

        if (bestCol !== null) {
          const item = remaining[bestCol.productIndex]!;
          const actualCount = Math.min(bestCol.count, item.quantity);
          // 逐层放置
          for (let k = 0; k < actualCount; k += 1) {
            const z = bestCol.box.z + k * bestCol.height;
            const singleBox = makeBox(bestCol.box.x, bestCol.box.y, z, bestCol.orientation.lengthMm, bestCol.orientation.widthMm, bestCol.height);
            allPlacements.push({
              productIndex: item.productIndex,
              sku: item.sku,
              orientation: bestCol.orientation,
              x: singleBox.x,
              y: singleBox.y,
              z: singleBox.z,
              containerIndex,
            });
            run.placed.push({ box: singleBox, productIndex: item.productIndex, weightG: item.weightG });
            run.usedWeightG += item.weightG;
          }
          item.quantity -= actualCount;
          placedInContainer += actualCount;
          progressed = true;

          // 以整列包围盒切分自由空间
          const nextSpaces: Space[] = [];
          for (const sp of run.spaces) {
            if (!overlaps(sp, bestCol.box)) {
              nextSpaces.push(sp);
              continue;
            }
            const pieces = splitSpace(sp, bestCol.box);
            for (const p of pieces) {
              if (run.placed.some((rec) => rec.box !== bestCol.box && contains(p, rec.box))) continue;
              nextSpaces.push(p);
            }
          }
          run.spaces = nextSpaces;
        } else {
          progressed = false;
        }
      }
    }

    const unloaded: UnloadedItem[] = remaining
      .filter((r) => r.quantity > 0)
      .map((r) => ({ sku: r.sku, productIndex: r.productIndex, remaining: r.quantity }));

    const loadedVolume = allPlacements.reduce((s, p) => s + p.orientation.lengthMm * p.orientation.widthMm * p.orientation.heightMm, 0);
    const loadedWeight = allPlacements.reduce((s, p) => s + (input.products[p.productIndex]?.weightG ?? 0), 0);
    const usedContainerIndexes = new Set(allPlacements.map((p) => p.containerIndex));

    const warnings: string[] = [];
    if (unloaded.length > 0) {
      warnings.push("存在未能装入的货物，请增加容器数量或放宽约束。");
    }

    return {
      placements: allPlacements,
      unloaded,
      metrics: {
        loadedVolumeMm3: loadedVolume,
        containerVolumeMm3: totalContainerVolume,
        volumeRatio: totalContainerVolume > 0 ? loadedVolume / totalContainerVolume : 0,
        loadedWeightG: loadedWeight,
        containerPayloadG: totalContainerPayload,
        weightRatio: totalContainerPayload > 0 ? loadedWeight / totalContainerPayload : 0,
        containersUsed: usedContainerIndexes.size,
      },
      warnings,
      solverVersion: "extreme-point/0.1.0",
    };
  }
}

function hasSupport(box: Box3, placed: PlacedRecord[], ratio: number): boolean {
  if (box.z <= EPS) return true; // 贴地无需支撑
  const baseArea = box.length * box.width;
  let supported = 0;
  for (const rec of placed) {
    // rec 顶面与本箱底面等高（贴住）
    if (Math.abs(rec.box.z2 - box.z) <= EPS + 1) {
      const ovL = Math.max(0, Math.min(box.x2, rec.box.x2) - Math.max(box.x, rec.box.x));
      const ovW = Math.max(0, Math.min(box.y2, rec.box.y2) - Math.max(box.y, rec.box.y));
      supported += ovL * ovW;
    }
  }
  return supported / baseArea >= ratio - EPS;
}

/** 便捷入口。 */
export function solveLoose(input: PlanInput, options?: SolverOptions): PlanResult {
  return new LoosePackingSolver(options).solve(input);
}
