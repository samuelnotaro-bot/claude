/**
 * Compact decorative banner: a photo tinted with the brand blue gradient,
 * sitting above a tab's real content as its own slim strip -- never behind
 * charts/tables/KPI numbers, so it can't compromise reading the dashboard.
 */
export function HeroBanner({ image, caption, focus = "center" }: { image: string; caption?: string; focus?: string }) {
  return (
    <div className="hero-banner" style={{ backgroundImage: `url("${image}")`, backgroundPosition: `${focus} 22%` }}>
      {caption && <div className="hero-banner-caption">{caption}</div>}
    </div>
  );
}
