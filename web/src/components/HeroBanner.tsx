/**
 * Compact decorative banner: a photo confined to a panel on the right (not
 * full-width), shown at its full height with zero vertical crop, fading
 * into the brand blue gradient on the left -- sitting above a tab's real
 * content as its own slim strip, never behind charts/tables/KPI numbers.
 */
export function HeroBanner({ image, caption }: { image: string; caption?: string }) {
  return (
    <div className="hero-banner">
      <div className="hero-banner-photo" style={{ backgroundImage: `url("${image}")` }} />
      {caption && <div className="hero-banner-caption">{caption}</div>}
    </div>
  );
}
