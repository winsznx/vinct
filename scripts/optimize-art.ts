/**
 * Turns the source illustrations into production image variants.
 *
 * The source art is a pair of large PNGs, around 1.8MB each. Shipping either one as the
 * production asset would trade a premium-looking hero for a slow first load, which is the
 * opposite of the point: the hero image is the largest contentful paint on the landing page, so
 * it is the single asset most worth getting right.
 *
 * Three rules shape what this emits.
 *
 * Never upscale. The hero source is 1672px wide and the footer 2172px, so a "2560" variant would
 * be an interpolated blur at three times the bytes. Requested widths above the source are
 * dropped, and the native width is always included so a large display still gets full detail.
 *
 * AVIF first, WebP second, PNG last. AVIF is roughly a third of WebP on this kind of
 * atmospheric gradient art, and both are dramatically smaller than PNG. The PNG fallback is
 * emitted at a single mid width only, because every browser that cannot read WebP is one this
 * product does not otherwise support, and a full PNG ladder would be dead weight in the repo.
 *
 * Quality is tuned per format rather than shared. These images are mostly smooth gradient and
 * fog, which is exactly where aggressive chroma subsampling shows banding, so AVIF keeps 4:4:4.
 *
 *   pnpm optimize-art
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp, { type Sharp } from "sharp";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(REPO_ROOT, "apps/web/src/assets/brand/source");
const OUTPUT_DIR = join(REPO_ROOT, "apps/web/public/brand");

interface Artwork {
  /** Basename of the source file, and the stem of every derivative. */
  name: string;
  /** Widths to emit, before the source width filters them. */
  widths: number[];
  /** The one width worth also emitting as PNG, for a browser with neither modern format. */
  fallbackWidth: number;
  /**
   * AVIF quality.
   *
   * Per artwork rather than shared. The hero is the brand moment and the largest contentful
   * paint, and at these sizes the difference between 58 and 68 is under 20KB, which buys back
   * the fine atmospheric grain that lower quality smooths out of the fog. The footer is
   * lazy-loaded, smoother art, and further down the page, so it stays lean.
   */
  quality: number;
}

const ARTWORK: Artwork[] = [
  {
    name: "vinct-hero-landscape",
    // The hero is 1672px native. Anything wider would be upscaling.
    widths: [480, 768, 1024, 1280, 1440, 1672],
    fallbackWidth: 1280,
    quality: 68,
  },
  {
    name: "vinct-footer-landscape",
    // The footer is 2172px native and 3:1, so it stays sharp across a very wide band.
    widths: [768, 1024, 1440, 1920, 2172],
    fallbackWidth: 1440,
    quality: 58,
  },
];

function kilobytes(path: string): number {
  return Math.round(statSync(path).size / 1024);
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE_DIR)) {
    throw new Error(
      `No source art at ${SOURCE_DIR}. Put the original PNGs there and run this again.`,
    );
  }

  // Rebuilt from scratch every run, so a renamed or removed source cannot leave an orphan
  // variant behind that a template still references.
  if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const rows: string[] = [];

  for (const art of ARTWORK) {
    const source = join(SOURCE_DIR, `${art.name}.png`);
    if (!existsSync(source)) throw new Error(`Missing source: ${source}`);

    const metadata = await sharp(source).metadata();
    const nativeWidth = metadata.width ?? 0;
    const nativeHeight = metadata.height ?? 0;
    if (nativeWidth === 0) throw new Error(`Could not read dimensions of ${source}`);

    const widths = [...new Set(art.widths.filter((width) => width <= nativeWidth))].sort(
      (a, b) => a - b,
    );
    const dropped = art.widths.filter((width) => width > nativeWidth);

    console.log(`\n${art.name}  ${nativeWidth}x${nativeHeight}  ${kilobytes(source)}KB source`);
    if (dropped.length > 0) {
      console.log(`  skipped ${dropped.join(", ")} — wider than the source, would be upscaling`);
    }

    for (const width of widths) {
      const pipeline = (): Sharp =>
        sharp(source).resize({ width, withoutEnlargement: true, kernel: "lanczos3" });

      const avif = join(OUTPUT_DIR, `${art.name}-${width}.avif`);
      await pipeline()
        // 4:4:4 because this art is smooth gradient and fog, where subsampled chroma bands
        // visibly. Effort 6 is the useful ceiling; 9 costs minutes for a rounding error.
        .avif({ quality: art.quality, effort: 6, chromaSubsampling: "4:4:4" })
        .toFile(avif);

      const webp = join(OUTPUT_DIR, `${art.name}-${width}.webp`);
      await pipeline()
        .webp({ quality: art.quality + 18, effort: 6, smartSubsample: true })
        .toFile(webp);

      rows.push(
        `  ${String(width).padStart(4)}px   avif ${String(kilobytes(avif)).padStart(4)}KB   webp ${String(kilobytes(webp)).padStart(4)}KB`,
      );
      console.log(rows[rows.length - 1]);
    }

    const fallbackWidth = Math.min(art.fallbackWidth, nativeWidth);
    const png = join(OUTPUT_DIR, `${art.name}-${fallbackWidth}.png`);
    await sharp(source)
      .resize({ width: fallbackWidth, withoutEnlargement: true, kernel: "lanczos3" })
      .png({ quality: 82, compressionLevel: 9, palette: true })
      .toFile(png);
    console.log(`  ${String(fallbackWidth).padStart(4)}px   png  ${kilobytes(png)}KB  (fallback)`);
  }

  const total = readdirSync(OUTPUT_DIR).reduce(
    (sum, file) => sum + statSync(join(OUTPUT_DIR, file)).size,
    0,
  );
  console.log(`\n${readdirSync(OUTPUT_DIR).length} files, ${Math.round(total / 1024)}KB total`);
  console.log("The source PNGs stay out of the build. Only these variants are served.");
}

await main();
