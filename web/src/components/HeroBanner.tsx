/**
 * Two-panel banner matching Socomec's own marketing layout: a solid blue
 * text panel on the left, a crisp full-color (not tinted/washed) photo panel
 * on the right -- sitting above a tab's real content as its own slim strip,
 * never behind charts/tables/KPI numbers.
 */
export function HeroBanner({ image, caption }: { image: string; caption?: string }) {
  return (
    <div className="hero-banner">
      <div className="hero-banner-text">{caption && <span>{caption}</span>}</div>
      <div className="hero-banner-photo" style={{ backgroundImage: `url("${image}")` }} />
    </div>
  );
}
