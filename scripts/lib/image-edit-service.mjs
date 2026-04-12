import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";

const FIT_MODES = new Set(["contain", "cover"]);
const CROP_ANCHORS = new Set(["center", "top", "bottom", "left", "right"]);
const ROTATIONS = new Set([0, 90, 180, 270]);

const DEFAULT_RECIPE = Object.freeze({
  fit: "contain",
  cropAnchor: "center",
  rotate: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  grayscale: false,
  invert: false,
  brightness: 1,
  contrast: 1,
  gamma: 1,
  vibrance: 1,
  sharpen: 0,
  blur: 0,
  blackPoint: 0,
  whitePoint: 1,
  targetScreenId: null
});

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.min(max, Math.max(min, value));
}

export function getDefaultEditRecipe() {
  return { ...DEFAULT_RECIPE };
}

export function normalizeEditRecipe(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const fit = FIT_MODES.has(input.fit) ? input.fit : DEFAULT_RECIPE.fit;
  const cropAnchor = CROP_ANCHORS.has(input.cropAnchor) ? input.cropAnchor : DEFAULT_RECIPE.cropAnchor;
  const rotate = ROTATIONS.has(Number(input.rotate)) ? Number(input.rotate) : DEFAULT_RECIPE.rotate;
  const zoom = clamp(Number(input.zoom), 1, 3) ?? DEFAULT_RECIPE.zoom;
  const panX = clamp(Number(input.panX), -1, 1) ?? DEFAULT_RECIPE.panX;
  const panY = clamp(Number(input.panY), -1, 1) ?? DEFAULT_RECIPE.panY;
  const grayscale = Boolean(input.grayscale);
  const invert = Boolean(input.invert);
  const brightness = clamp(Number(input.brightness), 0.5, 1.5) ?? DEFAULT_RECIPE.brightness;
  const contrast = clamp(Number(input.contrast), 0.5, 1.5) ?? DEFAULT_RECIPE.contrast;
  const gamma = clamp(Number(input.gamma), 1, 3) ?? DEFAULT_RECIPE.gamma;
  const vibrance = clamp(Number(input.vibrance), 0.5, 1.8) ?? DEFAULT_RECIPE.vibrance;
  const sharpen = clamp(Number(input.sharpen), 0, 5) ?? DEFAULT_RECIPE.sharpen;
  const blur = clamp(Number(input.blur), 0, 5) ?? DEFAULT_RECIPE.blur;
  const blackPoint = clamp(Number(input.blackPoint), 0, 0.4) ?? DEFAULT_RECIPE.blackPoint;
  const whitePoint = clamp(Number(input.whitePoint), 0.6, 1) ?? DEFAULT_RECIPE.whitePoint;
  const targetScreenId = null;
  const updatedAt = typeof input.updatedAt === "string" && input.updatedAt
    ? input.updatedAt
    : new Date().toISOString();

  if (isDefaultRecipe({ fit, cropAnchor, rotate, zoom, panX, panY, grayscale, invert, brightness, contrast, gamma, vibrance, sharpen, blur, blackPoint, whitePoint, targetScreenId })) {
    return null;
  }

  return {
    fit,
    cropAnchor,
    rotate,
    zoom,
    panX,
    panY,
    grayscale,
    invert,
    brightness,
    contrast,
    gamma,
    vibrance,
    sharpen,
    blur,
    blackPoint,
    whitePoint,
    targetScreenId,
    updatedAt
  };
}

export function isDefaultRecipe(recipe) {
  if (!recipe) {
    return true;
  }
  return (
    recipe.fit === DEFAULT_RECIPE.fit &&
    recipe.cropAnchor === DEFAULT_RECIPE.cropAnchor &&
    recipe.rotate === DEFAULT_RECIPE.rotate &&
    recipe.zoom === DEFAULT_RECIPE.zoom &&
    recipe.panX === DEFAULT_RECIPE.panX &&
    recipe.panY === DEFAULT_RECIPE.panY &&
    recipe.grayscale === DEFAULT_RECIPE.grayscale &&
    recipe.invert === DEFAULT_RECIPE.invert &&
    recipe.brightness === DEFAULT_RECIPE.brightness &&
    recipe.contrast === DEFAULT_RECIPE.contrast &&
    recipe.gamma === DEFAULT_RECIPE.gamma &&
    recipe.vibrance === DEFAULT_RECIPE.vibrance &&
    recipe.sharpen === DEFAULT_RECIPE.sharpen &&
    recipe.blur === DEFAULT_RECIPE.blur &&
    recipe.blackPoint === DEFAULT_RECIPE.blackPoint &&
    recipe.whitePoint === DEFAULT_RECIPE.whitePoint &&
    !recipe.targetScreenId
  );
}

function anchorToPosition(anchor) {
  switch (anchor) {
    case "top": return "top";
    case "bottom": return "bottom";
    case "left": return "left";
    case "right": return "right";
    default: return "centre";
  }
}

function anchorToBias(anchor) {
  switch (anchor) {
    case "top":
      return { x: 0.5, y: 0 };
    case "bottom":
      return { x: 0.5, y: 1 };
    case "left":
      return { x: 0, y: 0.5 };
    case "right":
      return { x: 1, y: 0.5 };
    default:
      return { x: 0.5, y: 0.5 };
  }
}

function clampToRange(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export async function applyEditRecipe(sourcePath, recipe, { targetWidth, targetHeight, outputFormat } = {}) {
  const normalized = normalizeEditRecipe(recipe);
  let basePipeline = sharp(sourcePath, { failOn: "none" }).rotate();

  if (normalized?.rotate) {
    basePipeline = basePipeline.rotate(normalized.rotate);
  }

  const baseBuffer = await basePipeline.toBuffer();
  let pipeline = sharp(baseBuffer, { failOn: "none" });

  if (targetWidth && targetHeight && normalized) {
    const metadata = await sharp(baseBuffer, { failOn: "none" }).metadata();
    const sourceWidth = metadata.width || targetWidth;
    const sourceHeight = metadata.height || targetHeight;
    const baseScale = normalized.fit === "cover"
      ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
      : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
    const finalScale = Math.max(0.01, baseScale * normalized.zoom);
    const resizedWidth = Math.max(1, Math.round(sourceWidth * finalScale));
    const resizedHeight = Math.max(1, Math.round(sourceHeight * finalScale));
    const resizedBuffer = await sharp(baseBuffer, { failOn: "none" })
      .resize({
        width: resizedWidth,
        height: resizedHeight,
        fit: "fill",
        withoutEnlargement: false
      })
      .toBuffer();

    const anchorBias = anchorToBias(normalized.cropAnchor);
    const minLeft = Math.min(0, targetWidth - resizedWidth);
    const maxLeft = Math.max(0, targetWidth - resizedWidth);
    const minTop = Math.min(0, targetHeight - resizedHeight);
    const maxTop = Math.max(0, targetHeight - resizedHeight);
    const anchorLeft = minLeft + ((maxLeft - minLeft) * anchorBias.x);
    const anchorTop = minTop + ((maxTop - minTop) * anchorBias.y);
    const panRangeX = Math.abs(maxLeft - minLeft) / 2;
    const panRangeY = Math.abs(maxTop - minTop) / 2;
    const left = Math.round(clampToRange(anchorLeft + (normalized.panX * panRangeX), minLeft, maxLeft));
    const top = Math.round(clampToRange(anchorTop + (normalized.panY * panRangeY), minTop, maxTop));
    const inputLeft = Math.max(0, -left);
    const inputTop = Math.max(0, -top);
    const outputLeft = Math.max(0, left);
    const outputTop = Math.max(0, top);
    const visibleWidth = Math.max(1, Math.min(resizedWidth - inputLeft, targetWidth - outputLeft));
    const visibleHeight = Math.max(1, Math.min(resizedHeight - inputTop, targetHeight - outputTop));
    const visibleBuffer = (inputLeft || inputTop || visibleWidth !== resizedWidth || visibleHeight !== resizedHeight)
      ? await sharp(resizedBuffer, { failOn: "none" })
          .extract({
            left: inputLeft,
            top: inputTop,
            width: visibleWidth,
            height: visibleHeight
          })
          .toBuffer()
      : resizedBuffer;

    pipeline = sharp({
      create: {
        width: targetWidth,
        height: targetHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    }).composite([{ input: visibleBuffer, left: outputLeft, top: outputTop }]);
  } else if (targetWidth && targetHeight) {
    pipeline = pipeline.resize({
      width: targetWidth,
      height: targetHeight,
      fit: "contain",
      position: anchorToPosition("center"),
      withoutEnlargement: false,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    });
  }

  if (normalized) {
    const needsLevels = normalized.blackPoint > 0 || normalized.whitePoint < 1;
    if (normalized.vibrance !== 1) {
      pipeline = pipeline.modulate({ saturation: normalized.vibrance });
    }
    if (normalized.gamma && normalized.gamma !== 1) {
      pipeline = pipeline.gamma(normalized.gamma);
    }
    if (needsLevels) {
      const range = Math.max(0.01, normalized.whitePoint - normalized.blackPoint);
      const a = 1 / range;
      const b = -normalized.blackPoint * 255 * a;
      pipeline = pipeline.linear(a, b);
    }
    if (normalized.brightness !== 1 || normalized.contrast !== 1) {
      if (normalized.contrast !== 1) {
        const a = normalized.contrast;
        const b = (1 - normalized.contrast) * 128;
        pipeline = pipeline.linear(a, b);
      }
      if (normalized.brightness !== 1) {
        pipeline = pipeline.modulate({ brightness: normalized.brightness });
      }
    }
    if (normalized.sharpen > 0) {
      pipeline = pipeline.sharpen({ sigma: normalized.sharpen });
    }
    if (normalized.blur > 0) {
      pipeline = pipeline.blur(Math.max(0.3, normalized.blur));
    }
    if (normalized.grayscale) {
      pipeline = pipeline.grayscale();
    }
    if (normalized.invert) {
      pipeline = pipeline.negate({ alpha: false });
    }
  }

  const ext = (outputFormat || path.extname(sourcePath).slice(1) || "png").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") {
    pipeline = pipeline.jpeg({ quality: 92 });
  } else if (ext === "webp") {
    pipeline = pipeline.webp({ quality: 92 });
  } else {
    pipeline = pipeline.png();
  }

  return pipeline.toBuffer();
}

export async function writeEditCache(cachePath, buffer) {
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.promises.writeFile(cachePath, buffer);
}
