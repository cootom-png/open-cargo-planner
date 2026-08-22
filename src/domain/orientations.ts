import type { Orientation, OrientationCode, ProductType } from "./model.js";

type OrientationTemplate = Pick<Orientation, "code" | "sideLoaded" | "upsideDown"> & {
  axes: readonly ["lengthMm" | "widthMm" | "heightMm", "lengthMm" | "widthMm" | "heightMm", "lengthMm" | "widthMm" | "heightMm"];
  horizontallyRotated: boolean;
};

const TEMPLATES: readonly OrientationTemplate[] = [
  { code: "LWH", axes: ["lengthMm", "widthMm", "heightMm"], sideLoaded: false, upsideDown: false, horizontallyRotated: false },
  { code: "WLH", axes: ["widthMm", "lengthMm", "heightMm"], sideLoaded: false, upsideDown: false, horizontallyRotated: true },
  { code: "LHW", axes: ["lengthMm", "heightMm", "widthMm"], sideLoaded: true, upsideDown: false, horizontallyRotated: false },
  { code: "HLW", axes: ["heightMm", "lengthMm", "widthMm"], sideLoaded: true, upsideDown: false, horizontallyRotated: true },
  { code: "WHL", axes: ["widthMm", "heightMm", "lengthMm"], sideLoaded: true, upsideDown: false, horizontallyRotated: false },
  { code: "HWL", axes: ["heightMm", "widthMm", "lengthMm"], sideLoaded: true, upsideDown: false, horizontallyRotated: true },
  { code: "LWH_INVERTED", axes: ["lengthMm", "widthMm", "heightMm"], sideLoaded: false, upsideDown: true, horizontallyRotated: false },
  { code: "WLH_INVERTED", axes: ["widthMm", "lengthMm", "heightMm"], sideLoaded: false, upsideDown: true, horizontallyRotated: true },
  { code: "LHW_INVERTED", axes: ["lengthMm", "heightMm", "widthMm"], sideLoaded: true, upsideDown: true, horizontallyRotated: false },
  { code: "HLW_INVERTED", axes: ["heightMm", "lengthMm", "widthMm"], sideLoaded: true, upsideDown: true, horizontallyRotated: true },
  { code: "WHL_INVERTED", axes: ["widthMm", "heightMm", "lengthMm"], sideLoaded: true, upsideDown: true, horizontallyRotated: false },
  { code: "HWL_INVERTED", axes: ["heightMm", "widthMm", "lengthMm"], sideLoaded: true, upsideDown: true, horizontallyRotated: true },
];

function isTemplateAllowed(product: ProductType, template: OrientationTemplate): boolean {
  if (product.mustStayUpright && (template.sideLoaded || template.upsideDown)) return false;
  if (template.sideLoaded && !product.allowSideLoading) return false;
  if (template.upsideDown && !product.allowUpsideDown) return false;

  if (template.horizontallyRotated && !product.allowHorizontalRotation) return false;

  if (product.allowedOrientations !== undefined && !product.allowedOrientations.includes(template.code)) {
    return false;
  }
  return true;
}

export function generateOrientations(product: ProductType): Orientation[] {
  const orientations: Orientation[] = [];
  const seen = new Set<string>();

  for (const template of TEMPLATES) {
    if (!isTemplateAllowed(product, template)) continue;
    const [lengthAxis, widthAxis, heightAxis] = template.axes;
    const orientation: Orientation = {
      code: template.code,
      lengthMm: product[lengthAxis],
      widthMm: product[widthAxis],
      heightMm: product[heightAxis],
      sideLoaded: template.sideLoaded,
      upsideDown: template.upsideDown,
    };
    const geometryKey = `${orientation.lengthMm}:${orientation.widthMm}:${orientation.heightMm}:${orientation.upsideDown}`;
    if (seen.has(geometryKey)) continue;
    seen.add(geometryKey);
    orientations.push(orientation);
  }

  return orientations;
}

export function orientationCodes(product: ProductType): OrientationCode[] {
  return generateOrientations(product).map((orientation) => orientation.code);
}
