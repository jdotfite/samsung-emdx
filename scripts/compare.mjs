import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const slug = process.argv[2] || "ten";
const referencePath = path.join(process.cwd(), `${slug}.png`);
const candidatePath = path.join(process.cwd(), "output", `${slug}.png`);
const diffPath = path.join(process.cwd(), "output", `${slug}-diff.png`);

if (!fs.existsSync(referencePath)) {
  throw new Error(`Reference image not found: ${referencePath}`);
}

if (!fs.existsSync(candidatePath)) {
  throw new Error(`Candidate image not found: ${candidatePath}`);
}

const reference = PNG.sync.read(fs.readFileSync(referencePath));
const candidate = PNG.sync.read(fs.readFileSync(candidatePath));

if (reference.width !== candidate.width || reference.height !== candidate.height) {
  throw new Error("Image dimensions do not match.");
}

const diff = new PNG({ width: reference.width, height: reference.height });
const mismatchedPixels = pixelmatch(
  reference.data,
  candidate.data,
  diff.data,
  reference.width,
  reference.height,
  { threshold: 0.1 },
);

fs.writeFileSync(diffPath, PNG.sync.write(diff));

const totalPixels = reference.width * reference.height;
const mismatchRate = ((mismatchedPixels / totalPixels) * 100).toFixed(2);

console.log(`Compared ${slug}`);
console.log(`Mismatched pixels: ${mismatchedPixels}`);
console.log(`Mismatch rate: ${mismatchRate}%`);
console.log(`Diff image: ${diffPath}`);
