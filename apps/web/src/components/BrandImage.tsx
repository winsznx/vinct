/**
 * The brand illustrations, served as responsive images rather than CSS backgrounds.
 *
 * A `background-image` cannot express a srcset, so a browser downloads whichever URL the
 * stylesheet names regardless of viewport or pixel density, and the hero stops being a
 * candidate for a sensible largest-contentful-paint. Semantic `<picture>` markup gets the right
 * bytes to every device and lets the browser start the fetch from the preload scanner, before
 * any stylesheet or script has run.
 *
 * Format order is AVIF, then WebP, then a single PNG. The browser takes the first `<source>` it
 * understands, so the smallest capable format wins without any scripting.
 *
 * Every variant width is real. The pipeline refuses to upscale, so the hero's ladder stops at
 * its native 1672px and the footer's at 2172px. Naming a width the file does not have would
 * make the browser download a blurred interpolation at triple the bytes.
 */

export type BrandArt = "hero" | "footer";

interface Variant {
  base: string;
  widths: number[];
  fallbackWidth: number;
  intrinsic: { width: number; height: number };
}

/** Kept in step with `scripts/optimize-art.ts`, which is the thing that emits these files. */
const ART: Record<BrandArt, Variant> = {
  hero: {
    base: "/brand/vinct-hero-landscape",
    widths: [480, 768, 1024, 1280, 1440, 1672],
    fallbackWidth: 1280,
    intrinsic: { width: 1672, height: 941 },
  },
  footer: {
    base: "/brand/vinct-footer-landscape",
    widths: [768, 1024, 1440, 1920, 2172],
    fallbackWidth: 1440,
    intrinsic: { width: 2172, height: 724 },
  },
};

function srcset(base: string, widths: number[], extension: string): string {
  return widths.map((width) => `${base}-${width}.${extension} ${width}w`).join(", ");
}

export function BrandImage({
  art,
  alt,
  sizes,
  priority = false,
  className,
  style,
}: {
  art: BrandArt;
  /**
   * Empty when the adjacent copy already says everything the picture says.
   *
   * These illustrations are atmosphere rather than information: every fact they suggest is
   * stated in the text beside them, so describing the scene again would only make a screen
   * reader slower without telling anybody anything new.
   */
  alt: string;
  sizes: string;
  /** True for the hero, which is the largest contentful paint and must not be lazy. */
  priority?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const variant = ART[art];
  return (
    <picture>
      <source
        type="image/avif"
        srcSet={srcset(variant.base, variant.widths, "avif")}
        sizes={sizes}
      />
      <source
        type="image/webp"
        srcSet={srcset(variant.base, variant.widths, "webp")}
        sizes={sizes}
      />
      <img
        src={`${variant.base}-${variant.fallbackWidth}.png`}
        alt={alt}
        // Intrinsic dimensions give the browser the aspect ratio before any byte arrives, so the
        // layout never shifts when the image lands.
        width={variant.intrinsic.width}
        height={variant.intrinsic.height}
        loading={priority ? "eager" : "lazy"}
        // High only for the hero. Marking everything high priority is the same as marking
        // nothing, and would have the footer competing with the image above the fold.
        fetchPriority={priority ? "high" : "low"}
        decoding="async"
        className={className}
        style={style}
        draggable={false}
      />
    </picture>
  );
}
