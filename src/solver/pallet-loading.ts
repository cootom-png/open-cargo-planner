import type { ContainerType, PlanInput } from "../domain/model.js";
import type { PalletLoadUnit, Placement, PlanResult, UnloadedItem } from "./types.js";

/**
 * 托盘装柜求解器（两阶段第二阶段）：
 * 把已码好的 PalletLoadUnit 作为不可拆分的刚体装入容器，
 * 并自动处理 50mm 托盘间距（通过 padding 实现）。
 */

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

interface PlacedPallet {
  box: Box3;
  unit: PalletLoadUnit;
  /** 该托盘在容器中的全局坐标（左下前角）。 */
  globalX: number;
  globalY: number;
  globalZ: number;
}

const EPS = 1e-6;
const PALLET_GAP_MM = 50; // 托盘间距

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
 * 3-残块空间切分（与 extreme-point.ts 保持一致）。
 */
function splitSpace(free: Space, occ: Box3): Space[] {
  const pieces: Space[] = [];
  // R：右侧全长条
  if (occ.x2 < free.x2 - EPS) {
    pieces.push(makeBox(occ.x2, free.y, free.z, free.x2 - occ.x2, free.width, free.height));
  }
  // Fr：前方条
  if (occ.y2 < free.y2 - EPS) {
    const xStart = free.x;
    const xEnd = Math.min(free.x2, occ.x2);
    if (xEnd - xStart > EPS) {
      pieces.push(makeBox(xStart, occ.y2, free.z, xEnd - xStart, free.y2 - occ.y2, free.height));
    }
  }
  // T：上方条
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

export interface PalletLoadingOptions {
  /** 是否启用托盘水平旋转（默认 true）。 */
  allowPalletRotation?: boolean;
  /** 单容器最大托盘数保护。 */
  maxPalletsPerContainer?: number;
}

interface OptionsRequired {
  allowPalletRotation: boolean;
  maxPalletsPerContainer: number;
}

function normalizeOptions(options?: PalletLoadingOptions): OptionsRequired {
  return {
    allowPalletRotation: options?.allowPalletRotation ?? true,
    maxPalletsPerContainer: options?.maxPalletsPerContainer ?? 1000,
  };
}

interface ContainerRun {
  type: ContainerType;
  spaces: Space[];
  placed: PlacedPallet[];
  usedWeightG: number;
}

interface PendingPallet {
  unit: PalletLoadUnit;
  index: number;
}

export class PalletLoadingSolver {
  private options: OptionsRequired;

  constructor(options?: PalletLoadingOptions) {
    this.options = normalizeOptions(options);
  }

  /**
   * 将托盘载荷装入容器。
   * @param pallets 已码好的托盘载荷列表
   * @param input 包含容器类型的输入（复用 PlanInput 结构）
   */
  solve(pallets: PalletLoadUnit[], input: PlanInput): PlanResult {
    if (pallets.length === 0) {
      return {
        placements: [],
        unloaded: [],
        metrics: {
          loadedVolumeMm3: 0,
          containerVolumeMm3: 0,
          volumeRatio: 0,
          loadedWeightG: 0,
          containerPayloadG: 0,
          weightRatio: 0,
          containersUsed: 0,
        },
        warnings: [],
        solverVersion: "pallet-loading/0.1.0",
      };
    }

    if (input.containerTypes.length === 0) {
      throw new Error("PlanInput 至少需要一种柜型。");
    }

    // 按体积降序排列托盘（大托盘优先）
    const pending: PendingPallet[] = pallets.map((unit, index) => ({ unit, index }));
    pending.sort((a, b) => {
      const volA = a.unit.palletLengthMm * a.unit.palletWidthMm * a.unit.totalHeightMm;
      const volB = b.unit.palletLengthMm * b.unit.palletWidthMm * b.unit.totalHeightMm;
      return volB - volA;
    });

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
    const warnings: string[] = [];

    for (const { containerIndex, type } of containerSequence) {
      if (remaining.every((r) => r.unit === null)) break;

      const run: ContainerRun = {
        type,
        spaces: [makeBox(0, 0, 0, type.innerLengthMm, type.innerWidthMm, type.innerHeightMm)],
        placed: [],
        usedWeightG: 0,
      };

      let placedInContainer = 0;
      let progressed = true;

      while (progressed && placedInContainer < this.options.maxPalletsPerContainer) {
        progressed = false;
        let bestPlacement: {
          space: Space;
          unit: PalletLoadUnit;
          box: Box3; // 含 padding 的包围盒
          pendingIndex: number;
          rotated: boolean;
        } | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;

        // 遍历所有空间和待装托盘
        for (const space of run.spaces) {
          for (let pi = 0; pi < remaining.length; pi += 1) {
            const item = remaining[pi];
            if (!item || item.unit === null) continue;

            const unit = item.unit;
            const palletWeight = unit.totalWeightG;

            // 检查重量约束
            if (run.usedWeightG + palletWeight > type.maxPayloadG) continue;

            // 尝试原始朝向和旋转朝向
            const orientations: Array<{ length: number; width: number; height: number; rotated: boolean }> = [
              { length: unit.palletLengthMm, width: unit.palletWidthMm, height: unit.totalHeightMm, rotated: false },
            ];

            if (this.options.allowPalletRotation) {
              orientations.push({
                length: unit.palletWidthMm,
                width: unit.palletLengthMm,
                height: unit.totalHeightMm,
                rotated: true,
              });
            }

            for (const orient of orientations) {
              // 含 padding 的实际占用尺寸
              const paddedLength = orient.length + PALLET_GAP_MM;
              const paddedWidth = orient.width + PALLET_GAP_MM;
              const paddedHeight = orient.height; // 高度方向无 padding（顶部无需间距）

              // 检查是否能放入空间
              if (
                paddedLength > space.length + EPS ||
                paddedWidth > space.width + EPS ||
                paddedHeight > space.height + EPS
              ) {
                continue;
              }

              // 构造含 padding 的包围盒（实际占用空间）
              const box = makeBox(space.x, space.y, space.z, paddedLength, paddedWidth, paddedHeight);

              // 检查是否与已放置的托盘碰撞
              let collision = false;
              for (const placed of run.placed) {
                if (overlaps(box, placed.box)) {
                  collision = true;
                  break;
                }
              }
              if (collision) continue;

              // 评分：体积最大优先（贪心策略）
              const volume = orient.length * orient.width * orient.height;
              if (volume > bestScore) {
                bestScore = volume;
                bestPlacement = { space, unit, box, pendingIndex: pi, rotated: orient.rotated };
              }
            }
          }
        }

        if (bestPlacement !== null) {
          const { unit, box, pendingIndex, rotated } = bestPlacement;

          // 托盘在容器中的实际坐标（不含 padding）
          const globalX = box.x;
          const globalY = box.y;
          const globalZ = box.z;

          // 记录已放置托盘
          run.placed.push({ box, unit, globalX, globalY, globalZ });
          run.usedWeightG += unit.totalWeightG;

          // 转换托盘内的每个箱体为全局坐标
          for (const item of unit.items) {
            let itemX = item.x;
            let itemY = item.y;
            let itemZ = item.z;
            let itemOrient = item.orientation;

            // 如果托盘旋转了 90°，需要变换坐标和朝向
            if (rotated) {
              // 坐标变换：托盘坐标系旋转 90°（绕 Z 轴）
              const newX = item.y;
              const newY = unit.palletLengthMm - item.x - item.orientation.lengthMm;
              itemX = newX;
              itemY = newY;

              // 朝向变换：长宽互换
              itemOrient = {
                ...item.orientation,
                lengthMm: item.orientation.widthMm,
                widthMm: item.orientation.lengthMm,
              };
            }

            allPlacements.push({
              productIndex: item.productIndex,
              sku: item.sku,
              orientation: itemOrient,
              x: globalX + itemX,
              y: globalY + itemY,
              z: globalZ + itemZ + unit.palletHeightMm, // 加上托盘自身高度
              containerIndex,
            });
          }

          // 标记该托盘已装载
          remaining[pendingIndex]!.unit = null as any;
          placedInContainer += 1;
          progressed = true;

          // 切分空间
          const nextSpaces: Space[] = [];
          for (const sp of run.spaces) {
            if (!overlaps(sp, box)) {
              nextSpaces.push(sp);
              continue;
            }
            const pieces = splitSpace(sp, box);
            for (const p of pieces) {
              // 检查新空间是否被其他已放置托盘完全包含（避免碎片）
              if (run.placed.some((rec) => rec.box !== box && contains(p, rec.box))) continue;
              nextSpaces.push(p);
            }
          }
          run.spaces = nextSpaces;
        } else {
          progressed = false;
        }
      }

      if (placedInContainer >= this.options.maxPalletsPerContainer) {
        warnings.push(`容器 ${containerIndex} 达到最大托盘数保护（${this.options.maxPalletsPerContainer}）。`);
      }
    }

    // 统计未装载的托盘
    const unloaded: UnloadedItem[] = [];
    for (const item of remaining) {
      if (item.unit !== null) {
        // 该托盘未装载，需将其内所有 SKU 加入 unloaded
        for (const skuItem of item.unit.skuSummary) {
          const existing = unloaded.find((u) => u.sku === skuItem.sku);
          if (existing) {
            existing.remaining += skuItem.quantity;
          } else {
            unloaded.push({
              sku: skuItem.sku,
              productIndex: skuItem.productIndex,
              remaining: skuItem.quantity,
            });
          }
        }
      }
    }

    const loadedVolume = allPlacements.reduce(
      (s, p) => s + p.orientation.lengthMm * p.orientation.widthMm * p.orientation.heightMm,
      0,
    );
    const loadedWeight = allPlacements.reduce((s, p) => {
      const product = input.products[p.productIndex];
      return s + (product?.weightG ?? 0);
    }, 0);
    const usedContainerIndexes = new Set(allPlacements.map((p) => p.containerIndex));

    if (unloaded.length > 0) {
      warnings.push("存在未能装入的托盘货物，请增加容器数量。");
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
      solverVersion: "pallet-loading/0.1.0",
    };
  }
}

/** 便捷入口。 */
export function solvePalletLoading(
  pallets: PalletLoadUnit[],
  input: PlanInput,
  options?: PalletLoadingOptions,
): PlanResult {
  return new PalletLoadingSolver(options).solve(pallets, input);
}
