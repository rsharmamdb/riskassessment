import { BRAND_LOGO_SVG } from "@/lib/brand";

export default function BrandLogo({
  className,
}: {
  className?: string;
}) {
  return (
    <span
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: BRAND_LOGO_SVG }}
    />
  );
}
