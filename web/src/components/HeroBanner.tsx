/**
 * Two-panel banner matching Socomec's own marketing layout: a solid blue
 * text panel on the left, a crisp full-color (not tinted/washed) photo panel
 * on the right -- sitting above a tab's real content as its own slim strip,
 * never behind charts/tables/KPI numbers.
 *
 * `zoom="fit"` (default "cover"): the photo panel is much wider than tall,
 * so `background-size: cover` crops heavily on images that aren't already
 * that wide -- the Overview banner image happens to be, the other 5 tabs'
 * images are a more moderate 3:1 and were getting nearly half their height
 * cropped off. "fit" scales down instead of cropping to fill, with a
 * matching brand-color backdrop for the resulting side margins.
 */
export function HeroBanner({ image, caption, zoom = "cover" }: { image: string; caption?: string; zoom?: "cover" | "fit" }) {
  return (
    <div className="hero-banner">
      <div className="hero-banner-text">{caption && <span>{caption}</span>}</div>
      <div className={`hero-banner-photo${zoom === "fit" ? " hero-banner-photo--fit" : ""}`} style={{ backgroundImage: `url("${image}")` }} />
    </div>
  );
}
